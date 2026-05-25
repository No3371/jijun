/**
 * 輕鬆記帳 Self-Hosted Server
 *
 * Serves the frontend SPA from ../dist and exposes a full data API.
 * Each user is identified by a 64-hex-char key (X-Data-Key header)
 * which maps 1:1 to a SQLite database file in DATA_DIR.
 *
 * Routes:
 *   GET  /api/health                  health check
 *   POST /api/auth/token              Google OAuth token exchange (proxy)
 *   POST /api/auth/refresh            Google OAuth token refresh (proxy)
 *   *    /api/data/*                  user data (key-gated)
 *   GET  /*                           static SPA files
 *
 * Environment:
 *   PORT                 listen port (default 8787)
 *   DATA_DIR             SQLite files directory (default ../data)
 *   GOOGLE_CLIENT_ID     Google OAuth client id
 *   GOOGLE_CLIENT_SECRET Google OAuth client secret
 *   ALLOWED_ORIGINS      comma-separated CORS origins (empty = same-origin only)
 *   MAX_BODY_BYTES       max request body size in bytes (default 52428800 = 50 MB)
 *   MAX_DBS              max concurrent open SQLite handles (default 500)
 *   NEW_DB_RATE_LIMIT    max new database creations per IP per hour (default 20)
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import {
  handleRecords, handleAccounts, handleLedgers, handleSettings,
  handleContacts, handleDebts, handleRecurring, handleAmortizations,
  handleThemes, handlePlugins, handleFiles, handleSyncLog, handleByUUID,
  handleImport, handleExport, handleBackup, handleRestore,
} from './routes/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const DIST_DIR = join(__dirname, '../../dist');
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10);
const NEW_DB_RATE_LIMIT = parseInt(process.env.NEW_DB_RATE_LIMIT || '20', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

const KEY_RE = /^[0-9a-f]{64}$/;

// ── IP rate limiter for new DB creation ───────────────────────────────────
// Tracks how many new (previously unseen) keys each IP opened in the current hour.
const newDbCountByIp = new Map(); // ip → { count, resetAt }

function checkNewDbRateLimit(ip) {
  const now = Date.now();
  const entry = newDbCountByIp.get(ip) ?? { count: 0, resetAt: now + 3_600_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 3_600_000; }
  if (entry.count >= NEW_DB_RATE_LIMIT) return false;
  entry.count++;
  newDbCountByIp.set(ip, entry);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mimeType(filePath) {
  return MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// H3 fix: default to empty string (no cross-origin access) instead of '*'
function corsHeaders(req) {
  const rawAllowed = process.env.ALLOWED_ORIGINS || '';
  if (!rawAllowed) return {};
  const allowed = rawAllowed.split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers['origin'] || '';
  const hdrs = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Data-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed.includes('*')) {
    hdrs['Access-Control-Allow-Origin'] = '*';
  } else if (allowed.includes(origin)) {
    hdrs['Access-Control-Allow-Origin'] = origin;
    hdrs['Vary'] = 'Origin';
  }
  return hdrs;
}

// H1 fix: read body with a hard size cap
async function readBodyRaw(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Payload too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// M3 fix: explicit path containment guard for static files
function serveStatic(req, res, urlPath) {
  const candidates = urlPath === '/' ? ['index.html'] : [urlPath.replace(/^\//, ''), 'index.html'];
  for (const candidate of candidates) {
    const filePath = join(DIST_DIR, candidate);
    // Ensure resolved path stays inside DIST_DIR
    if (!filePath.startsWith(DIST_DIR + sep) && filePath !== DIST_DIR) continue;
    if (existsSync(filePath)) {
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          res.writeHead(200, { 'Content-Type': mimeType(filePath), 'Content-Length': stat.size });
          createReadStream(filePath).pipe(res);
          return;
        }
      } catch (_) { /* try next */ }
    }
  }
  // SPA fallback
  const index = join(DIST_DIR, 'index.html');
  if (existsSync(index)) {
    const stat = statSync(index);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': stat.size });
    createReadStream(index).pipe(res);
  } else {
    res.writeHead(404); res.end('Not found');
  }
}

// C1 fix: full try/catch + body size limit for OAuth handler
async function handleOAuth(req, res, pathname, ch) {
  try {
    const raw = await readBodyRaw(req, 64 * 1024); // 64 KB max for OAuth payloads
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { ...ch, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const env = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
    };

    let tokenBody;
    if (pathname === '/api/auth/token') {
      tokenBody = new URLSearchParams({
        code: body.code ?? '',
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: body.redirect_uri || 'postmessage',
        grant_type: 'authorization_code',
      });
    } else {
      tokenBody = new URLSearchParams({
        refresh_token: body.refresh_token ?? '',
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      });
    }

    const gRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const data = await gRes.json();
    res.writeHead(gRes.status, { ...ch, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (e) {
    if (e.statusCode === 413) {
      res.writeHead(413, { ...ch, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
    } else {
      console.error('OAuth handler error:', e.message);
      res.writeHead(500, { ...ch, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

async function routeData(req, res, db, method, segments) {
  // segments: ['data', resource, id?, sub?]
  const [, resource, id, sub] = segments;

  switch (resource) {
    case 'records': return handleRecords(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'accounts': return handleAccounts(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'ledgers': return handleLedgers(req, res, db, method, id);
    case 'settings': return handleSettings(req, res, db, method, id);
    case 'contacts': return handleContacts(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'debts': return handleDebts(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'recurring': return handleRecurring(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'amortizations': return handleAmortizations(req, res, db, method, id, new URL(req.url, 'http://x'));
    case 'themes': return handleThemes(req, res, db, method, id);
    case 'plugins': return handlePlugins(req, res, db, method, id);
    case 'files': return handleFiles(req, res, db, method, id);
    case 'sync-log': return handleSyncLog(req, res, db, method, new URL(req.url, 'http://x'));
    case 'by-uuid': return handleByUUID(req, res, db, method, id, sub);
    case 'import': return handleImport(req, res, db);
    case 'export': return handleExport(req, res, db);
    case 'backup': return method === 'GET' ? handleBackup(req, res, db) : handleRestore(req, res, db);
    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
  }
}

const server = createServer(async (req, res) => {
  const ch = corsHeaders(req);
  const method = req.method.toUpperCase();
  const pathname = new URL(req.url, 'http://x').pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, ch); res.end(); return;
  }

  // Add CORS headers to all API responses
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  // Health
  if (method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'jijun-server', timestamp: new Date().toISOString() }));
    return;
  }

  // OAuth proxy
  if (method === 'POST' && (pathname === '/api/auth/token' || pathname === '/api/auth/refresh')) {
    await handleOAuth(req, res, pathname, ch); return;
  }

  // Data API — requires valid X-Data-Key
  if (pathname.startsWith('/api/data/')) {
    const key = req.headers['x-data-key'];
    if (!key || !KEY_RE.test(key)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid X-Data-Key' }));
      return;
    }

    // C2 fix: rate-limit new DB file creation per IP
    const { isNew, db } = getDb(key);
    if (isNew) {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown';
      if (!checkNewDbRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many new databases created from this IP. Try again later.' }));
        return;
      }
    }

    const segments = pathname.replace('/api/', '').split('/');
    try {
      await routeData(req, res, db, method, segments);
    } catch (e) {
      if (e.statusCode === 413) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        // H2 fix: log internally, never expose e.message to clients
        console.error('Data API error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
    return;
  }

  // Static files
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║         輕鬆記帳 Self-Hosted Server           ║
╠═══════════════════════════════════════════════╣
║  Listening on  http://localhost:${String(PORT).padEnd(14)}║
║  Data API      /api/data/*                    ║
║  Health        /api/health                    ║
╚═══════════════════════════════════════════════╝
  `);
});
