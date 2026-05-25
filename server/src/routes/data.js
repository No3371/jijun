/**
 * Data API route handlers — all keyed by X-Data-Key header
 * Each handler receives (req, res, db) where db is the caller's SQLite instance.
 */

import * as db_records from '../db.js';
import {
  records, accounts, ledgers, settings, contacts, debts,
  recurring, amortizations, themes, plugins, files, syncLog, randomUUID,
} from '../db.js';

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function err(res, message, status = 400) {
  json(res, { error: message }, status);
}

// ── Records ────────────────────────────────────────────────────────────────

export async function handleRecords(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    if (filters.accountId) filters.accountId = parseInt(filters.accountId);
    if (filters.amortizationId != null && filters.amortizationId !== '') filters.amortizationId = parseInt(filters.amortizationId);
    return json(res, records.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const record = records.get(db, parseInt(id));
    return record ? json(res, record) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = records.add(db, body.record ?? body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = records.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    records.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Accounts ───────────────────────────────────────────────────────────────

export async function handleAccounts(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    return json(res, accounts.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const a = accounts.get(db, parseInt(id));
    return a ? json(res, a) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = accounts.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = accounts.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    accounts.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Ledgers ────────────────────────────────────────────────────────────────

export async function handleLedgers(req, res, db, method, id) {
  if (method === 'GET' && !id) return json(res, ledgers.getAll(db));
  if (method === 'GET' && id) {
    const l = ledgers.get(db, parseInt(id));
    return l ? json(res, l) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    if (!body.uuid) body.uuid = randomUUID();
    body.createdAt = body.createdAt ?? Date.now();
    const newId = ledgers.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = ledgers.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    const numId = parseInt(id);
    if (numId === 1) return err(res, '不可刪除預設帳本', 400);
    // Cascade delete all data in this ledger
    for (const store of [records, accounts, contacts, debts, recurring, amortizations]) {
      const items = store.getAll(db, { ledgerId: numId });
      for (const item of items) store.delete(db, item.id);
    }
    ledgers.delete(db, numId);
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Settings ───────────────────────────────────────────────────────────────

export async function handleSettings(req, res, db, method, key) {
  if (method === 'GET' && !key) {
    return json(res, settings.getAll(db));
  }
  if (method === 'GET' && key) {
    const val = settings.get(db, key);
    // Match old DataService format: { key, value } or null
    return json(res, val !== null ? val : null);
  }
  if ((method === 'PUT' || method === 'POST') && key) {
    const body = await readBody(req);
    // body can be { key, value } (old format) or just the value directly
    const value = body.value !== undefined ? body.value : body;
    settings.set(db, key, { key, value });
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Contacts ───────────────────────────────────────────────────────────────

export async function handleContacts(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    return json(res, contacts.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const c = contacts.get(db, parseInt(id));
    return c ? json(res, c) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = contacts.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = contacts.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    contacts.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Debts ──────────────────────────────────────────────────────────────────

export async function handleDebts(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    if (filters.contactId != null) filters.contactId = parseInt(filters.contactId);
    if (filters.settled != null) filters.settled = filters.settled === 'true';
    return json(res, debts.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const d = debts.get(db, parseInt(id));
    return d ? json(res, d) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = debts.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = debts.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    debts.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Recurring Transactions ─────────────────────────────────────────────────

export async function handleRecurring(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    return json(res, recurring.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const r = recurring.get(db, parseInt(id));
    return r ? json(res, r) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = recurring.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = recurring.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    recurring.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Amortizations ──────────────────────────────────────────────────────────

export async function handleAmortizations(req, res, db, method, id, url) {
  if (method === 'GET' && !id) {
    const filters = Object.fromEntries(url.searchParams);
    if (filters.allLedgers !== undefined) filters.allLedgers = filters.allLedgers === 'true';
    if (filters.ledgerId) filters.ledgerId = parseInt(filters.ledgerId);
    return json(res, amortizations.getAll(db, filters));
  }
  if (method === 'GET' && id) {
    const a = amortizations.get(db, parseInt(id));
    return a ? json(res, a) : err(res, 'Not found', 404);
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const newId = amortizations.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    const updated = amortizations.update(db, parseInt(id), body);
    return updated ? json(res, updated) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    amortizations.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Themes ─────────────────────────────────────────────────────────────────

export async function handleThemes(req, res, db, method, id) {
  if (method === 'GET' && !id) return json(res, themes.getAll(db));
  if (method === 'GET' && id) {
    const t = themes.get(db, id);
    return t ? json(res, t) : err(res, 'Not found', 404);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    body.id = id;
    themes.put(db, body);
    return json(res, { ok: true });
  }
  if (method === 'DELETE' && id) {
    themes.delete(db, id);
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Plugins ────────────────────────────────────────────────────────────────

export async function handlePlugins(req, res, db, method, id) {
  if (method === 'GET' && !id) return json(res, plugins.getAll(db));
  if (method === 'GET' && id) {
    const p = plugins.get(db, id);
    return json(res, p ?? null);
  }
  if (method === 'PUT' && id) {
    const body = await readBody(req);
    body.id = id;
    plugins.put(db, body);
    return json(res, { ok: true });
  }
  if (method === 'DELETE' && id) {
    plugins.delete(db, id);
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Files ──────────────────────────────────────────────────────────────────

export async function handleFiles(req, res, db, method, id) {
  if (method === 'POST') {
    const body = await readBody(req, FILE_MAX);
    const newId = files.add(db, body);
    return json(res, { id: newId }, 201);
  }
  if (method === 'GET' && id) {
    const f = files.get(db, parseInt(id));
    return f ? json(res, f) : err(res, 'Not found', 404);
  }
  if (method === 'DELETE' && id) {
    files.delete(db, parseInt(id));
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── Sync Log ───────────────────────────────────────────────────────────────

export async function handleSyncLog(req, res, db, method, url) {
  if (method === 'GET') {
    const since = parseInt(url.searchParams.get('since') ?? '0');
    return json(res, syncLog.getSince(db, since));
  }
  if (method === 'POST') {
    const body = await readBody(req);
    syncLog.add(db, body);
    return json(res, { ok: true });
  }
  if (method === 'DELETE') {
    const before = parseInt(url.searchParams.get('before') ?? '0');
    syncLog.clearBefore(db, before);
    return json(res, { ok: true });
  }
  err(res, 'Method not allowed', 405);
}

// ── By UUID ────────────────────────────────────────────────────────────────

const storeMap = { records, accounts, contacts, debts, recurring_transactions: recurring, amortizations, ledgers };

export function handleByUUID(req, res, db, method, storeName, uuid) {
  if (method !== 'GET') return err(res, 'Method not allowed', 405);
  const store = storeMap[storeName];
  if (!store) return err(res, 'Unknown store', 404);
  const item = store.getByUUID?.(db, uuid);
  return item ? json(res, item) : json(res, null);
}

// ── Bulk Import ────────────────────────────────────────────────────────────

export async function handleImport(req, res, db) {
  const data = await readBody(req);

  // Clear all data
  for (const store of [records, accounts, contacts, debts, recurring, amortizations]) store.clear(db);
  ledgers.clear(db);

  const oldToNewLedger = new Map();
  const oldToNewAccount = new Map();
  const oldToNewContact = new Map();
  const oldToNewDebt = new Map();
  const oldToNewRecord = new Map();

  // Settings
  if (data.settings) {
    for (const [k, v] of Object.entries(data.settings)) {
      settings.set(db, k, { key: k, value: v });
    }
  }
  if (data.customCategories) settings.set(db, 'custom_categories', { key: 'custom_categories', value: data.customCategories });
  if (data.categoryOrder) settings.set(db, 'category_order', { key: 'category_order', value: data.categoryOrder });
  if (data.hiddenCategories) settings.set(db, 'hidden_categories', { key: 'hidden_categories', value: data.hiddenCategories });
  if (data.budgetSettingsMap) {
    for (const [k, v] of Object.entries(data.budgetSettingsMap)) {
      settings.set(db, k, { key: k, value: v });
    }
  } else if (data.budgetSettings) {
    settings.set(db, 'budget_settings', { key: 'budget_settings', value: data.budgetSettings });
  }

  // Ledgers
  if (data.ledgers?.length) {
    for (const ledger of data.ledgers) {
      const oldId = ledger.id;
      const { id: _id, ...ld } = ledger;
      if (!ld.uuid) ld.uuid = randomUUID();
      ld.createdAt = ld.createdAt ?? Date.now();
      const newId = ledgers.add(db, ld);
      oldToNewLedger.set(oldId, newId);
    }
  }

  const mapLedger = (oldId) => oldId != null && oldToNewLedger.has(oldId) ? oldToNewLedger.get(oldId) : 1;

  // Accounts
  if (data.accounts?.length) {
    for (const acc of data.accounts) {
      const oldId = acc.id;
      const { id: _id, ...ad } = acc;
      ad.ledgerId = mapLedger(ad.ledgerId);
      if (!ad.uuid) ad.uuid = randomUUID();
      const newId = accounts.add(db, ad);
      oldToNewAccount.set(oldId, newId);
    }
  }

  // Contacts
  if (data.contacts?.length) {
    for (const c of data.contacts) {
      const oldId = c.id;
      const { id: _id, ...cd } = c;
      cd.ledgerId = mapLedger(cd.ledgerId);
      if (!cd.uuid) cd.uuid = randomUUID();
      const newId = contacts.add(db, cd);
      oldToNewContact.set(oldId, newId);
    }
  }

  // Debts (phase 1)
  if (data.debts?.length) {
    for (const d of data.debts) {
      const oldId = d.id;
      const { id: _id, ...dd } = d;
      dd.ledgerId = mapLedger(dd.ledgerId);
      if (!dd.uuid) dd.uuid = randomUUID();
      if (dd.contactId) dd.contactId = oldToNewContact.get(dd.contactId) ?? dd.contactId;
      if (dd.remainingAmount == null) dd.remainingAmount = dd.originalAmount ?? dd.amount ?? 0;
      if (dd.originalAmount == null) dd.originalAmount = dd.amount ?? dd.remainingAmount ?? 0;
      const newId = debts.add(db, dd);
      oldToNewDebt.set(oldId, newId);
    }
  }

  // Records
  const recordsSource = data.version?.startsWith('2.') ? (data.records ?? []) : [];
  for (const rec of recordsSource) {
    if (!rec.date || !rec.type || !rec.category || typeof rec.amount !== 'number') continue;
    const oldId = rec.id;
    const { id: _id, ...rd } = rec;
    rd.ledgerId = mapLedger(rd.ledgerId);
    if (!rd.uuid) rd.uuid = randomUUID();
    if (!rd.timestamp) rd.timestamp = Date.now();
    if (rd.accountId) rd.accountId = oldToNewAccount.get(rd.accountId) ?? rd.accountId;
    if (rd.debtId) rd.debtId = oldToNewDebt.get(rd.debtId) ?? rd.debtId;
    const newId = records.add(db, rd);
    if (oldId != null) oldToNewRecord.set(oldId, newId);
  }

  // Debts phase 2 – fix record links
  if (data.debts?.length) {
    for (const d of data.debts) {
      const newId = oldToNewDebt.get(d.id);
      if (!newId) continue;
      const stored = debts.get(db, newId);
      if (!stored) continue;
      let changed = false;
      if (d.recordId && oldToNewRecord.has(d.recordId)) {
        stored.recordId = oldToNewRecord.get(d.recordId);
        changed = true;
      }
      if (stored.payments?.length) {
        stored.payments = stored.payments.map(p => {
          if (p.recordId && oldToNewRecord.has(p.recordId)) {
            changed = true;
            return { ...p, recordId: oldToNewRecord.get(p.recordId) };
          }
          return p;
        });
      }
      if (changed) debts.update(db, newId, stored);
    }
  }

  // Recurring
  if (data.recurring_transactions?.length) {
    for (const rt of data.recurring_transactions) {
      const { id: _id, ...rtd } = rt;
      rtd.ledgerId = mapLedger(rtd.ledgerId);
      if (!rtd.uuid) rtd.uuid = randomUUID();
      if (rtd.accountId) rtd.accountId = oldToNewAccount.get(rtd.accountId) ?? rtd.accountId;
      recurring.add(db, rtd);
    }
  }

  // Amortizations
  if (data.amortizations?.length) {
    for (const am of data.amortizations) {
      const { id: _id, ...amd } = am;
      amd.ledgerId = mapLedger(amd.ledgerId);
      if (!amd.uuid) amd.uuid = randomUUID();
      amortizations.add(db, amd);
    }
  }

  const activeLedgerId = data.activeLedgerId != null && oldToNewLedger.has(data.activeLedgerId)
    ? oldToNewLedger.get(data.activeLedgerId)
    : 1;

  json(res, { success: true, totalRecords: recordsSource.length, activeLedgerId });
}

// ── Full Export ────────────────────────────────────────────────────────────

export function handleExport(req, res, db) {
  const all = records.getAll(db, { allLedgers: true });
  const allAccounts = accounts.getAll(db, { allLedgers: true });
  const allContacts = contacts.getAll(db, { allLedgers: true });
  const allDebts = debts.getAll(db, { allLedgers: true });
  const allLedgers = ledgers.getAll(db);
  const allRecurring = recurring.getAll(db, { allLedgers: true });
  const allAmortizations = amortizations.getAll(db, { allLedgers: true });
  const allSettings = settings.getAll(db);

  json(res, {
    version: '2.3.0',
    exportDate: new Date().toISOString(),
    settings: {
      advancedAccountModeEnabled: allSettings.advancedAccountModeEnabled?.value ?? false,
      debtManagementEnabled: allSettings.debtManagementEnabled?.value ?? false,
    },
    activeLedgerId: 1,
    ledgers: allLedgers,
    accounts: allAccounts,
    records: all,
    contacts: allContacts,
    debts: allDebts,
    recurring_transactions: allRecurring,
    amortizations: allAmortizations,
    customCategories: allSettings.custom_categories?.value ?? null,
    categoryOrder: allSettings.category_order?.value ?? null,
    hiddenCategories: allSettings.hidden_categories?.value ?? null,
    budgetSettingsMap: Object.fromEntries(
      Object.entries(allSettings)
        .filter(([k]) => k === 'budget_settings' || k.startsWith('budget_settings_'))
        .map(([k, v]) => [k, v?.value ?? v])
    ),
    metadata: {
      totalRecords: all.length,
      totalContacts: allContacts.length,
      totalDebts: allDebts.length,
      totalLedgers: allLedgers.length,
    },
  });
}

// ── Backup / Restore ───────────────────────────────────────────────────────

export function handleBackup(req, res, db) {
  const backup = {
    records: records.getAll(db, { allLedgers: true }),
    accounts: accounts.getAll(db, { allLedgers: true }),
    contacts: contacts.getAll(db, { allLedgers: true }),
    debts: debts.getAll(db, { allLedgers: true }),
    recurring_transactions: recurring.getAll(db, { allLedgers: true }),
    amortizations: amortizations.getAll(db, { allLedgers: true }),
    ledgers: ledgers.getAll(db),
    settings: settings.getAll(db),
  };
  json(res, backup);
}

export async function handleRestore(req, res, db) {
  const backup = await readBody(req);
  for (const store of [records, accounts, contacts, debts, recurring, amortizations]) store.clear(db);
  ledgers.clear(db);

  if (backup.ledgers) for (const { id: _id, ...l } of backup.ledgers) ledgers.add(db, l);
  if (backup.accounts) for (const { id: _id, ...a } of backup.accounts) accounts.add(db, a);
  if (backup.contacts) for (const { id: _id, ...c } of backup.contacts) contacts.add(db, c);
  if (backup.debts) for (const { id: _id, ...d } of backup.debts) debts.add(db, d);
  if (backup.records) for (const { id: _id, ...r } of backup.records) records.add(db, r);
  if (backup.recurring_transactions) for (const { id: _id, ...r } of backup.recurring_transactions) recurring.add(db, r);
  if (backup.amortizations) for (const { id: _id, ...a } of backup.amortizations) amortizations.add(db, a);
  if (backup.settings) {
    for (const [k, v] of Object.entries(backup.settings)) settings.set(db, k, v);
  }
  json(res, { ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────

// H1 fix: enforce a per-request body size cap; throws {statusCode:413} on excess.
const DEFAULT_MAX = parseInt(process.env.MAX_BODY_BYTES || String(50 * 1024 * 1024), 10);
const FILE_MAX    = parseInt(process.env.MAX_FILE_BYTES  || String(10 * 1024 * 1024), 10);

async function readBody(req, maxBytes = DEFAULT_MAX) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const e = new Error('Payload too large');
      e.statusCode = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
