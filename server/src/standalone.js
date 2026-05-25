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
 *   ALLOWED_ORIGINS      comma-separated CORS origins (default *)
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
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

function mimeType(filePath) {
  return MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function corsHeaders(req) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const origin = req.headers['origin'] || '';
  const hdrs = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Data-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed.includes('*') || allowed.includes(origin)) {
    hdrs['Access-Control-Allow-Origin'] = allowed.includes('*') ? '*' : origin;
  }
  return hdrs;
}

function serveStatic(req, res, urlPath) {
  const candidates = urlPath === '/' ? ['index.html'] : [urlPath.replace(/^\//, ''), 'index.html'];
  for (const candidate of candidates) {
    const filePath = join(DIST_DIR, candidate);
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

async function handleOAuth(req, res, pathname) {
  const ch = corsHeaders(req);
  const env = { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '', GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '' };
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  let tokenBody;

  if (pathname === '/api/auth/token') {
    tokenBody = new URLSearchParams({ code: body.code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: body.redirect_uri || 'postmessage', grant_type: 'authorization_code' });
  } else {
    tokenBody = new URLSearchParams({ refresh_token: body.refresh_token, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' });
  }

  const gRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenBody });
  const data = await gRes.json();
  res.writeHead(gRes.status, { ...ch, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function routeData(req, res, db, method, segments) {
  // segments: ['data', resource, id?, ...]
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
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' }));
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

  // Add CORS to all API responses
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  // Health
  if (method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'jijun-server', timestamp: new Date().toISOString() }));
    return;
  }

  // OAuth proxy
  if (method === 'POST' && (pathname === '/api/auth/token' || pathname === '/api/auth/refresh')) {
    await handleOAuth(req, res, pathname); return;
  }

  // Data API — requires X-Data-Key
  if (pathname.startsWith('/api/data/')) {
    const key = req.headers['x-data-key'];
    if (!key || !KEY_RE.test(key)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid X-Data-Key' }));
      return;
    }
    const db = getDb(key);
    const segments = pathname.replace('/api/', '').split('/');
    try {
      await routeData(req, res, db, method, segments);
    } catch (e) {
      console.error('Data API error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', message: e.message }));
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
