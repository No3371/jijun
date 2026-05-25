import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto'; // M2 fix: cryptographically secure

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../data');
const MAX_DBS = parseInt(process.env.MAX_DBS || '500', 10);

mkdirSync(DATA_DIR, { recursive: true });

// M5 fix: LRU cache — Map insertion order tracks recency; evict oldest when full.
const dbCache = new Map();

export function getDb(key) {
  if (dbCache.has(key)) {
    // Refresh LRU position
    const db = dbCache.get(key);
    dbCache.delete(key);
    dbCache.set(key, db);
    return { isNew: false, db };
  }

  // Evict oldest entry if at capacity
  if (dbCache.size >= MAX_DBS) {
    const oldestKey = dbCache.keys().next().value;
    const old = dbCache.get(oldestKey);
    try { old.close(); } catch (_) { /* ignore close errors */ }
    dbCache.delete(oldestKey);
  }

  const dbPath = join(DATA_DIR, `${key}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  dbCache.set(key, db);
  return { isNew: true, db };
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      date TEXT,
      type TEXT,
      category TEXT,
      accountId INTEGER,
      amortizationId INTEGER,
      ledgerId INTEGER DEFAULT 1,
      timestamp INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
    CREATE INDEX IF NOT EXISTS idx_records_ledgerId ON records(ledgerId);
    CREATE INDEX IF NOT EXISTS idx_records_amortizationId ON records(amortizationId);

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      ledgerId INTEGER DEFAULT 1,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_ledgerId ON accounts(ledgerId);

    CREATE TABLE IF NOT EXISTS ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      ledgerId INTEGER DEFAULT 1,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_ledgerId ON contacts(ledgerId);

    CREATE TABLE IF NOT EXISTS debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      contactId INTEGER,
      ledgerId INTEGER DEFAULT 1,
      settled INTEGER DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_debts_ledgerId ON debts(ledgerId);

    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      ledgerId INTEGER DEFAULT 1,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_ledgerId ON recurring_transactions(ledgerId);

    CREATE TABLE IF NOT EXISTS amortizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      ledgerId INTEGER DEFAULT 1,
      status TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_amortizations_ledgerId ON amortizations(ledgerId);

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT,
      data TEXT,
      createdAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT,
      storeName TEXT,
      recordId TEXT,
      data TEXT,
      timestamp INTEGER,
      deviceId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
  `);

  // Seed default ledger if absent
  const hasLedger = db.prepare('SELECT id FROM ledgers WHERE id = 1').get();
  if (!hasLedger) {
    const uuid = randomUUID();
    const ledger = { id: 1, uuid, name: '預設帳本', icon: 'fa-solid fa-book', color: '#334A52', type: 'personal', createdAt: Date.now() };
    db.prepare('INSERT INTO ledgers (id, uuid, data) VALUES (1, ?, ?)').run(uuid, JSON.stringify(ledger));
  }
}

// ── Serialization helpers ──────────────────────────────────────────────────

function rowToObj(row) {
  if (!row) return null;
  const obj = JSON.parse(row.data);
  obj.id = row.id;
  return obj;
}

function objToData(obj) {
  const { id: _id, ...rest } = obj;
  return JSON.stringify(rest);
}

// ── Records ────────────────────────────────────────────────────────────────

export const records = {
  add(db, record) {
    const { id: _id, uuid, date, type, category, accountId, amortizationId, ledgerId, timestamp } = record;
    const data = objToData(record);
    const stmt = db.prepare(
      'INSERT INTO records (uuid, date, type, category, accountId, amortizationId, ledgerId, timestamp, data) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const result = stmt.run(uuid ?? null, date ?? null, type ?? null, category ?? null, accountId ?? null, amortizationId ?? null, ledgerId ?? 1, timestamp ?? Date.now(), data);
    return result.lastInsertRowid;
  },

  get(db, id) {
    return rowToObj(db.prepare('SELECT * FROM records WHERE id = ?').get(id));
  },

  getAll(db, filters = {}) {
    let rows = db.prepare('SELECT * FROM records').all();
    let items = rows.map(rowToObj);

    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(r => r.ledgerId === lid);
    }
    if (filters.startDate) items = items.filter(r => r.date >= filters.startDate);
    if (filters.endDate) items = items.filter(r => r.date <= filters.endDate);
    if (filters.type) items = items.filter(r => r.type === filters.type);
    if (filters.category) items = items.filter(r => r.category === filters.category);
    if (filters.accountId) items = items.filter(r => r.accountId === filters.accountId);
    if (filters.amortizationId != null) items = items.filter(r => r.amortizationId === filters.amortizationId);

    return items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    if (!row) return null;
    const existing = rowToObj(row);
    const updated = { ...existing, ...updates, id };
    const data = objToData(updated);
    db.prepare(
      'UPDATE records SET uuid=?, date=?, type=?, category=?, accountId=?, amortizationId=?, ledgerId=?, timestamp=?, data=? WHERE id=?'
    ).run(updated.uuid ?? null, updated.date ?? null, updated.type ?? null, updated.category ?? null, updated.accountId ?? null, updated.amortizationId ?? null, updated.ledgerId ?? 1, updated.timestamp ?? Date.now(), data, id);
    return updated;
  },

  delete(db, id) {
    db.prepare('DELETE FROM records WHERE id = ?').run(id);
    return true;
  },

  getByUUID(db, uuid) {
    return rowToObj(db.prepare('SELECT * FROM records WHERE uuid = ?').get(uuid));
  },

  clear(db) { db.prepare('DELETE FROM records').run(); },
};

// ── Accounts ───────────────────────────────────────────────────────────────

export const accounts = {
  add(db, account) {
    const { uuid, ledgerId } = account;
    const stmt = db.prepare('INSERT INTO accounts (uuid, ledgerId, data) VALUES (?,?,?)');
    const r = stmt.run(uuid ?? null, ledgerId ?? 1, objToData(account));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)); },

  getAll(db, filters = {}) {
    let items = db.prepare('SELECT * FROM accounts').all().map(rowToObj);
    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(a => a.ledgerId === lid);
    }
    return items;
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE accounts SET uuid=?, ledgerId=?, data=? WHERE id=?')
      .run(updated.uuid ?? null, updated.ledgerId ?? 1, objToData(updated), id);
    return updated;
  },

  delete(db, id) { db.prepare('DELETE FROM accounts WHERE id = ?').run(id); return true; },
  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM accounts WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM accounts').run(); },
};

// ── Ledgers ────────────────────────────────────────────────────────────────

export const ledgers = {
  add(db, ledger) {
    const { uuid } = ledger;
    const r = db.prepare('INSERT INTO ledgers (uuid, data) VALUES (?,?)').run(uuid ?? null, objToData(ledger));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id)); },
  getAll(db) { return db.prepare('SELECT * FROM ledgers').all().map(rowToObj); },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE ledgers SET uuid=?, data=? WHERE id=?').run(updated.uuid ?? null, objToData(updated), id);
    return updated;
  },

  delete(db, id) {
    db.prepare('DELETE FROM ledgers WHERE id = ?').run(id);
    return true;
  },

  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM ledgers WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM ledgers WHERE id != 1').run(); },
};

// ── Settings ───────────────────────────────────────────────────────────────

export const settings = {
  get(db, key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    return JSON.parse(row.value);
  },

  set(db, key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
  },

  getAll(db) {
    return db.prepare('SELECT key, value FROM settings').all().reduce((acc, r) => {
      acc[r.key] = JSON.parse(r.value);
      return acc;
    }, {});
  },
};

// ── Contacts ───────────────────────────────────────────────────────────────

export const contacts = {
  add(db, contact) {
    const { uuid, ledgerId } = contact;
    const r = db.prepare('INSERT INTO contacts (uuid, ledgerId, data) VALUES (?,?,?)').run(uuid ?? null, ledgerId ?? 1, objToData(contact));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)); },

  getAll(db, filters = {}) {
    let items = db.prepare('SELECT * FROM contacts').all().map(rowToObj);
    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(c => c.ledgerId === lid);
    }
    return items;
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE contacts SET uuid=?, ledgerId=?, data=? WHERE id=?').run(updated.uuid ?? null, updated.ledgerId ?? 1, objToData(updated), id);
    return updated;
  },

  delete(db, id) { db.prepare('DELETE FROM contacts WHERE id = ?').run(id); return true; },
  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM contacts WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM contacts').run(); },
};

// ── Debts ──────────────────────────────────────────────────────────────────

export const debts = {
  add(db, debt) {
    const { uuid, contactId, ledgerId, settled } = debt;
    const r = db.prepare('INSERT INTO debts (uuid, contactId, ledgerId, settled, data) VALUES (?,?,?,?,?)')
      .run(uuid ?? null, contactId ?? null, ledgerId ?? 1, settled ? 1 : 0, objToData(debt));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM debts WHERE id = ?').get(id)); },

  getAll(db, filters = {}) {
    let items = db.prepare('SELECT * FROM debts').all().map(rowToObj);
    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(d => d.ledgerId === lid);
    }
    if (filters.contactId != null) items = items.filter(d => d.contactId === filters.contactId);
    if (filters.type) items = items.filter(d => d.type === filters.type);
    if (filters.settled != null) items = items.filter(d => d.settled === filters.settled);
    return items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM debts WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE debts SET uuid=?, contactId=?, ledgerId=?, settled=?, data=? WHERE id=?')
      .run(updated.uuid ?? null, updated.contactId ?? null, updated.ledgerId ?? 1, updated.settled ? 1 : 0, objToData(updated), id);
    return updated;
  },

  delete(db, id) { db.prepare('DELETE FROM debts WHERE id = ?').run(id); return true; },
  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM debts WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM debts').run(); },
};

// ── Recurring Transactions ─────────────────────────────────────────────────

export const recurring = {
  add(db, item) {
    const r = db.prepare('INSERT INTO recurring_transactions (uuid, ledgerId, data) VALUES (?,?,?)').run(item.uuid ?? null, item.ledgerId ?? 1, objToData(item));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(id)); },

  getAll(db, filters = {}) {
    let items = db.prepare('SELECT * FROM recurring_transactions').all().map(rowToObj);
    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(r => r.ledgerId === lid);
    }
    return items;
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE recurring_transactions SET uuid=?, ledgerId=?, data=? WHERE id=?').run(updated.uuid ?? null, updated.ledgerId ?? 1, objToData(updated), id);
    return updated;
  },

  delete(db, id) { db.prepare('DELETE FROM recurring_transactions WHERE id = ?').run(id); return true; },
  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM recurring_transactions WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM recurring_transactions').run(); },
};

// ── Amortizations ──────────────────────────────────────────────────────────

export const amortizations = {
  add(db, item) {
    const r = db.prepare('INSERT INTO amortizations (uuid, ledgerId, status, data) VALUES (?,?,?,?)').run(item.uuid ?? null, item.ledgerId ?? 1, item.status ?? null, objToData(item));
    return r.lastInsertRowid;
  },

  get(db, id) { return rowToObj(db.prepare('SELECT * FROM amortizations WHERE id = ?').get(id)); },

  getAll(db, filters = {}) {
    let items = db.prepare('SELECT * FROM amortizations').all().map(rowToObj);
    if (!filters.allLedgers) {
      const lid = filters.ledgerId ?? 1;
      items = items.filter(a => a.ledgerId === lid);
    }
    if (filters.status) items = items.filter(a => a.status === filters.status);
    return items;
  },

  update(db, id, updates) {
    const row = db.prepare('SELECT * FROM amortizations WHERE id = ?').get(id);
    if (!row) return null;
    const updated = { ...rowToObj(row), ...updates, id };
    db.prepare('UPDATE amortizations SET uuid=?, ledgerId=?, status=?, data=? WHERE id=?').run(updated.uuid ?? null, updated.ledgerId ?? 1, updated.status ?? null, objToData(updated), id);
    return updated;
  },

  delete(db, id) { db.prepare('DELETE FROM amortizations WHERE id = ?').run(id); return true; },
  getByUUID(db, uuid) { return rowToObj(db.prepare('SELECT * FROM amortizations WHERE uuid = ?').get(uuid)); },
  clear(db) { db.prepare('DELETE FROM amortizations').run(); },
};

// ── Themes ─────────────────────────────────────────────────────────────────

export const themes = {
  getAll(db) {
    return db.prepare('SELECT * FROM themes').all().map(r => JSON.parse(r.data));
  },
  get(db, id) {
    const row = db.prepare('SELECT * FROM themes WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  },
  put(db, themeData) {
    db.prepare('INSERT OR REPLACE INTO themes (id, data) VALUES (?,?)').run(themeData.id, JSON.stringify(themeData));
  },
  delete(db, id) { db.prepare('DELETE FROM themes WHERE id = ?').run(id); },
};

// ── Plugins ────────────────────────────────────────────────────────────────

export const plugins = {
  getAll(db) {
    return db.prepare('SELECT * FROM plugins').all().map(r => JSON.parse(r.data));
  },
  get(db, id) {
    const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  },
  put(db, pluginData) {
    db.prepare('INSERT OR REPLACE INTO plugins (id, data) VALUES (?,?)').run(pluginData.id, JSON.stringify(pluginData));
  },
  delete(db, id) { db.prepare('DELETE FROM plugins WHERE id = ?').run(id); },
};

// ── Files ──────────────────────────────────────────────────────────────────

export const files = {
  add(db, file) {
    const r = db.prepare('INSERT INTO files (name, type, data, createdAt) VALUES (?,?,?,?)').run(file.name ?? 'file', file.type ?? 'application/octet-stream', file.data ?? null, file.createdAt ?? Date.now());
    return r.lastInsertRowid;
  },
  get(db, id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id) ?? null;
  },
  delete(db, id) { db.prepare('DELETE FROM files WHERE id = ?').run(id); },
};

// ── Sync Log ───────────────────────────────────────────────────────────────

export const syncLog = {
  add(db, entry) {
    db.prepare('INSERT INTO sync_log (operation, storeName, recordId, data, timestamp, deviceId) VALUES (?,?,?,?,?,?)').run(
      entry.operation, entry.storeName, String(entry.recordId), JSON.stringify(entry.data), entry.timestamp, entry.deviceId ?? null
    );
  },

  getSince(db, since) {
    return db.prepare('SELECT * FROM sync_log WHERE timestamp >= ?').all(since).map(r => ({
      ...r,
      data: r.data ? JSON.parse(r.data) : null,
    }));
  },

  clearBefore(db, ts) {
    db.prepare('DELETE FROM sync_log WHERE timestamp <= ?').run(ts);
  },
};

export { randomUUID }; // re-export node:crypto's randomUUID
