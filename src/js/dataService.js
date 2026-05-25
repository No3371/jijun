import { getOrCreateKey } from './keyManager.js';
import { customConfirm } from './utils.js';

class DataService {
  constructor() {
    this.activeLedgerId = parseInt(localStorage.getItem('activeLedgerId') || '1', 10);
    this.hookProvider = null;
    this._syncDeviceId = localStorage.getItem('sync_device_id') || 'unknown';
    this._key = null;
  }

  setHookProvider(fn) { this.hookProvider = fn; }

  async triggerHook(hookName, payload) {
    if (this.hookProvider) return await this.hookProvider(hookName, payload);
    return payload;
  }

  async init() {
    this._key = getOrCreateKey();
  }

  _headers() {
    return { 'Content-Type': 'application/json', 'X-Data-Key': this._key };
  }

  async _get(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async _post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }

  async _put(path, body) {
    const res = await fetch(path, { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
    return res.json();
  }

  async _delete(path) {
    const res = await fetch(path, { method: 'DELETE', headers: this._headers() });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
    return res.json();
  }

  generateUUID() {
    if (self.crypto?.randomUUID) return self.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Records ──────────────────────────────────────────────────────────────

  async addRecord(record, skipLog = false) {
    let recordToSave = {
      ...record,
      ledgerId: record.ledgerId ?? this.activeLedgerId,
      timestamp: Date.now(),
      uuid: record.uuid || this.generateUUID(),
    };

    if (!skipLog) {
      recordToSave = await this.triggerHook('onRecordSaveBefore', recordToSave);
      if (!recordToSave) return null;
    }

    const result = await this._post('/api/data/records', { record: recordToSave, skipLog });

    if (!skipLog) {
      await this.triggerHook('onRecordSaveAfter', { ...recordToSave, id: result.id });
      await this.logChange('add', 'records', result.id, { ...recordToSave, id: result.id });
    }

    return result.id;
  }

  async getRecords(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      if (filters.type) params.type = filters.type;
      if (filters.category) params.category = filters.category;
      if (filters.accountId) params.accountId = filters.accountId;
      if (filters.amortizationId != null) params.amortizationId = filters.amortizationId;
      return await this._get('/api/data/records', params);
    } catch (e) {
      console.error('getRecords failed:', e);
      return [];
    }
  }

  async getRecord(id) {
    try { return await this._get(`/api/data/records/${id}`); }
    catch { return null; }
  }

  async updateRecord(id, updates, skipLog = false) {
    if (!skipLog) {
      const updated = await this._put(`/api/data/records/${id}`, updates);
      await this.triggerHook('onRecordUpdateAfter', updated);
      await this.logChange('update', 'records', id, updated);
      return updated;
    }
    return this._put(`/api/data/records/${id}`, updates);
  }

  async deleteRecord(id, skipLog = false) {
    if (!skipLog) {
      const record = await this.getRecord(id);
      const shouldDelete = await this.triggerHook('onRecordDeleteBefore', { id });
      if (!shouldDelete) throw new Error('Delete cancelled by plugin');
      await this._delete(`/api/data/records/${id}`);
      await this.triggerHook('onRecordDeleteAfter', { id });
      if (record) {
        await this.logChange('delete', 'records', id, { uuid: record.uuid, ledgerId: record.ledgerId, accountId: record.accountId });
      }
      return true;
    }
    await this._delete(`/api/data/records/${id}`);
    return true;
  }

  async getAllRecords() { return this.getRecords({ allLedgers: true }); }

  // ── Amortizations ─────────────────────────────────────────────────────────

  async addAmortization(data, skipLog = false) {
    if (!data.uuid) data.uuid = this.generateUUID();
    const toSave = { ...data, ledgerId: data.ledgerId ?? this.activeLedgerId, createdAt: data.createdAt ?? Date.now() };
    const r = await this._post('/api/data/amortizations', toSave);
    if (!skipLog) await this.logChange('add', 'amortizations', r.id, toSave);
    return r.id;
  }

  async getAmortizations(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      if (filters.status) params.status = filters.status;
      return await this._get('/api/data/amortizations', params);
    } catch { return []; }
  }

  async getAmortization(id) {
    try { return await this._get(`/api/data/amortizations/${id}`); }
    catch { return null; }
  }

  async updateAmortization(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/amortizations/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'amortizations', id, updated);
    return updated;
  }

  async deleteAmortization(id, skipLog = false) {
    if (!skipLog) {
      const item = await this.getAmortization(id);
      await this._delete(`/api/data/amortizations/${id}`);
      await this.logChange('delete', 'amortizations', id, { uuid: item?.uuid });
    } else {
      await this._delete(`/api/data/amortizations/${id}`);
    }
    return true;
  }

  // ── Recurring Transactions ────────────────────────────────────────────────

  async addRecurringTransaction(transaction, skipLog = false) {
    if (!transaction.uuid) transaction.uuid = this.generateUUID();
    const toSave = { ...transaction, ledgerId: transaction.ledgerId ?? this.activeLedgerId };
    const r = await this._post('/api/data/recurring', toSave);
    if (!skipLog) await this.logChange('add', 'recurring_transactions', r.id, toSave);
    return r.id;
  }

  async getRecurringTransactions(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      return await this._get('/api/data/recurring', params);
    } catch { return []; }
  }

  async updateRecurringTransaction(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/recurring/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'recurring_transactions', id, updated);
    return updated;
  }

  async deleteRecurringTransaction(id, skipLog = false) {
    if (!skipLog) {
      const item = await this._get(`/api/data/recurring/${id}`).catch(() => null);
      await this._delete(`/api/data/recurring/${id}`);
      await this.logChange('delete', 'recurring_transactions', id, { uuid: item?.uuid });
    } else {
      await this._delete(`/api/data/recurring/${id}`);
    }
    return true;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getSetting(key) {
    try { return await this._get(`/api/data/settings/${key}`); }
    catch { return null; }
  }

  async saveSetting(setting) {
    await this._put(`/api/data/settings/${setting.key}`, setting);
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  async getStatistics(startDate, endDate, accountId = null, offsetTransfers = false) {
    const filters = { startDate, endDate };
    if (accountId) filters.accountId = accountId;
    let allRecords = await this.getRecords(filters);

    if (offsetTransfers) allRecords = allRecords.filter(r => r.category !== 'transfer');
    allRecords = allRecords.filter(r => r.category !== 'debt_collection' && r.category !== 'debt_repayment');

    const stats = { totalIncome: 0, totalExpense: 0, incomeByCategory: {}, expenseByCategory: {}, dailyTotals: {}, records: allRecords };

    const debtIds = [...new Set(allRecords.filter(r => r.debtId).map(r => r.debtId))];
    const debtsMap = {};
    for (const debtId of debtIds) {
      const debt = await this.getDebt(debtId);
      if (debt) debtsMap[debtId] = debt;
    }

    const adjustedRecords = [];
    allRecords.forEach(record => {
      let effectiveAmount = record.amount;
      if (record.debtId && debtsMap[record.debtId]) {
        const debt = debtsMap[record.debtId];
        const isSettled = debt.settled === true;
        const isReceivable = debt.type === 'receivable';
        if (record.type === 'expense' && isReceivable) {
          const myExpense = Math.max(0, record.amount - (debt.originalAmount || 0));
          effectiveAmount = isSettled ? myExpense : record.amount;
        } else if (record.type === 'income' && isReceivable) {
          effectiveAmount = isSettled ? record.amount : 0;
        } else if (record.type === 'expense' && !isReceivable) {
          effectiveAmount = isSettled ? record.amount : 0;
        } else if (record.type === 'income' && !isReceivable) {
          effectiveAmount = isSettled ? 0 : record.amount;
        }
      }
      if (effectiveAmount === 0) return;
      const adj = { ...record, amount: effectiveAmount };
      adjustedRecords.push(adj);
      if (adj.type === 'income') {
        stats.totalIncome += effectiveAmount;
        stats.incomeByCategory[adj.category] = (stats.incomeByCategory[adj.category] || 0) + effectiveAmount;
      } else {
        stats.totalExpense += effectiveAmount;
        stats.expenseByCategory[adj.category] = (stats.expenseByCategory[adj.category] || 0) + effectiveAmount;
      }
      const date = adj.date;
      if (!stats.dailyTotals[date]) stats.dailyTotals[date] = { income: 0, expense: 0 };
      stats.dailyTotals[date][adj.type === 'income' ? 'income' : 'expense'] += effectiveAmount;
    });

    stats.records = adjustedRecords;
    return stats;
  }

  // ── Export / Import ───────────────────────────────────────────────────────

  async exportData(options = {}) {
    try {
      const data = await this._get('/api/data/export');
      const { includeRecords = true, includeAccounts = true, includeDebts = true, includeCategories = true } = options;
      if (!includeRecords) { data.records = []; }
      if (!includeAccounts) { data.accounts = []; }
      if (!includeDebts) { data.contacts = []; data.debts = []; }
      if (!includeCategories) { data.customCategories = null; data.categoryOrder = null; data.hiddenCategories = null; }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `記帳資料_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      console.error('匯出資料失敗:', e);
      throw e;
    }
  }

  async importData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const data = JSON.parse(event.target.result);
          if ((await this.getRecords()).length > 0) {
            const confirmed = await customConfirm('匯入新資料將會覆蓋所有現有資料 (包含紀錄、帳戶、分類設定)。\n\n確定要繼續嗎？');
            if (!confirmed) { resolve({ success: false, message: '使用者取消操作' }); return; }
          }
          const result = await this._post('/api/data/import', data);
          if (result.success) {
            this.setActiveLedger(result.activeLedgerId || 1);
            resolve({ success: true, message: `成功匯入 ${result.totalRecords} 筆記錄` });
          } else {
            reject(new Error(result.error || '匯入失敗'));
          }
        } catch (e) {
          console.error('匯入失敗:', e);
          reject(new Error('檔案格式錯誤或損壞'));
        }
      };
      reader.onerror = () => reject(new Error('讀取檔案失敗'));
      reader.readAsText(file);
    });
  }

  async _exportFullBackup() {
    return this._get('/api/data/backup');
  }

  async _restoreFromBackup(backup) {
    await this._post('/api/data/backup', backup);
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  async addAccount(account, skipLog = false) {
    if (!account.uuid) account.uuid = this.generateUUID();
    const toAdd = { ...account, ledgerId: account.ledgerId ?? this.activeLedgerId };
    delete toAdd.id;
    const r = await this._post('/api/data/accounts', toAdd);
    if (!skipLog) await this.logChange('add', 'accounts', r.id, { ...toAdd, id: r.id });
    return r.id;
  }

  async getAccount(id) {
    try { return await this._get(`/api/data/accounts/${id}`); }
    catch { return null; }
  }

  async getAccounts(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      return await this._get('/api/data/accounts', params);
    } catch { return []; }
  }

  async updateAccount(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/accounts/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'accounts', id, updated);
    return updated;
  }

  async deleteAccount(id, skipLog = false) {
    if (!skipLog) {
      const item = await this.getAccount(id);
      await this._delete(`/api/data/accounts/${id}`);
      await this.logChange('delete', 'accounts', id, { uuid: item?.uuid, ledgerId: item?.ledgerId });
    } else {
      await this._delete(`/api/data/accounts/${id}`);
    }
    return true;
  }

  async clearAllAccounts() {
    const all = await this.getAccounts({ allLedgers: true });
    for (const a of all) await this._delete(`/api/data/accounts/${a.id}`);
    return true;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async addContact(contact, skipLog = false) {
    const toAdd = skipLog
      ? { ...contact, uuid: contact.uuid || this.generateUUID() }
      : { name: contact.name, avatarFileId: contact.avatarFileId || null, createdAt: Date.now(), uuid: contact.uuid || this.generateUUID() };
    toAdd.ledgerId = toAdd.ledgerId ?? this.activeLedgerId;
    delete toAdd.id;
    const r = await this._post('/api/data/contacts', toAdd);
    if (!skipLog) await this.logChange('add', 'contacts', r.id, { ...toAdd, id: r.id });
    return r.id;
  }

  async getContact(id) {
    try { return await this._get(`/api/data/contacts/${id}`); }
    catch { return null; }
  }

  async getContacts(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      return await this._get('/api/data/contacts', params);
    } catch { return []; }
  }

  async updateContact(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/contacts/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'contacts', id, updated);
    return updated;
  }

  async deleteContact(id, skipLog = false) {
    if (!skipLog) {
      const item = await this.getContact(id);
      await this._delete(`/api/data/contacts/${id}`);
      await this.logChange('delete', 'contacts', id, { uuid: item?.uuid, ledgerId: item?.ledgerId });
    } else {
      await this._delete(`/api/data/contacts/${id}`);
    }
    return true;
  }

  async clearAllContacts() {
    const all = await this.getContacts({ allLedgers: true });
    for (const c of all) await this._delete(`/api/data/contacts/${c.id}`);
    return true;
  }

  // ── Debts ─────────────────────────────────────────────────────────────────

  async addDebt(debt, skipLog = false) {
    let debtData;
    if (skipLog) {
      const amount = debt.amount ?? debt.originalAmount ?? debt.remainingAmount ?? 0;
      debtData = {
        ...debt,
        originalAmount: debt.originalAmount ?? amount,
        remainingAmount: debt.remainingAmount ?? amount,
        uuid: debt.uuid || this.generateUUID(),
      };
    } else {
      const amount = debt.amount;
      debtData = {
        type: debt.type, contactId: debt.contactId,
        originalAmount: amount, remainingAmount: amount,
        recordId: debt.recordId || null,
        date: debt.date, description: debt.description || '',
        settled: false, settledAt: null, payments: [],
        createdAt: Date.now(), uuid: debt.uuid || this.generateUUID(),
      };
    }
    debtData.ledgerId = debtData.ledgerId ?? this.activeLedgerId;
    delete debtData.id;
    const r = await this._post('/api/data/debts', debtData);
    if (!skipLog) await this.logChange('add', 'debts', r.id, { ...debtData, id: r.id });
    return r.id;
  }

  async getDebt(id) {
    try { return await this._get(`/api/data/debts/${id}`); }
    catch { return null; }
  }

  async getDebts(filters = {}) {
    try {
      const params = {};
      if (filters.allLedgers) params.allLedgers = 'true';
      else params.ledgerId = filters.ledgerId ?? this.activeLedgerId;
      if (filters.contactId != null) params.contactId = filters.contactId;
      if (filters.type) params.type = filters.type;
      if (filters.settled != null) params.settled = filters.settled;
      return await this._get('/api/data/debts', params);
    } catch { return []; }
  }

  async updateDebt(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/debts/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'debts', id, updated);
    return updated;
  }

  async deleteDebt(id, skipLog = false) {
    if (!skipLog) {
      const item = await this.getDebt(id);
      await this._delete(`/api/data/debts/${id}`);
      await this.logChange('delete', 'debts', id, { uuid: item?.uuid, ledgerId: item?.ledgerId });
    } else {
      await this._delete(`/api/data/debts/${id}`);
    }
    return true;
  }

  async clearAllDebts() {
    const all = await this.getDebts({ allLedgers: true });
    for (const d of all) await this._delete(`/api/data/debts/${d.id}`);
    return true;
  }

  async settleDebt(id, paymentAmount = null) {
    const debt = await this.getDebt(id);
    if (!debt) throw new Error('Debt not found');
    if (debt.settled) return debt;

    const amount = paymentAmount || debt.remainingAmount;
    const newRemainingAmount = debt.remainingAmount - amount;
    const isFullySettled = newRemainingAmount <= 0;

    const paymentRecord = { amount, date: new Date().toISOString().split('T')[0], recordId: null };

    let newRecordId = null;
    if (!debt.recordId) {
      const contact = await this.getContact(debt.contactId);
      const contactName = contact?.name || '未知聯絡人';
      const record = {
        type: debt.type === 'receivable' ? 'income' : 'expense',
        category: debt.type === 'receivable' ? 'debt_collection' : 'debt_repayment',
        amount, date: new Date().toISOString().split('T')[0],
        description: debt.type === 'receivable'
          ? `收回欠款：${contactName} - ${debt.description}${!isFullySettled ? ' (部分)' : ''}`
          : `還款：${contactName} - ${debt.description}${!isFullySettled ? ' (部分)' : ''}`,
        ledgerId: debt.ledgerId, debtId: id,
      };
      newRecordId = await this.addRecord(record);
    }

    paymentRecord.recordId = newRecordId;
    if (newRecordId) {
      const newRecord = await this.getRecord(newRecordId);
      if (newRecord?.uuid) paymentRecord.recordUuid = newRecord.uuid;
    } else if (debt.recordUuid) {
      paymentRecord.recordUuid = debt.recordUuid;
      paymentRecord.recordId = debt.recordId;
    }

    const updates = { remainingAmount: Math.max(0, newRemainingAmount), payments: [...(debt.payments || []), paymentRecord] };
    if (isFullySettled) { updates.settled = true; updates.settledAt = Date.now(); }
    return this.updateDebt(id, updates);
  }

  async addPartialPayment(debtId, amount) { return this.settleDebt(debtId, amount); }

  async getDebtSummary() {
    try {
      const debtList = await this.getDebts({ settled: false });
      const contactList = await this.getContacts();
      let totalReceivable = 0, totalPayable = 0;
      const byContact = {};
      for (const debt of debtList) {
        const amount = debt.remainingAmount ?? debt.originalAmount ?? debt.amount ?? 0;
        if (debt.type === 'receivable') totalReceivable += amount;
        else totalPayable += amount;
        if (!byContact[debt.contactId]) {
          const contact = contactList.find(c => c.id === debt.contactId);
          byContact[debt.contactId] = { contact: contact || { id: debt.contactId, name: '未知聯絡人' }, receivable: 0, payable: 0, debts: [] };
        }
        if (debt.type === 'receivable') byContact[debt.contactId].receivable += amount;
        else byContact[debt.contactId].payable += amount;
        byContact[debt.contactId].debts.push(debt);
      }
      return { totalReceivable, totalPayable, byContact: Object.values(byContact) };
    } catch { return { totalReceivable: 0, totalPayable: 0, byContact: [] }; }
  }

  // ── Ledgers ───────────────────────────────────────────────────────────────

  setActiveLedger(ledgerId) {
    this.activeLedgerId = ledgerId;
    localStorage.setItem('activeLedgerId', String(ledgerId));
  }

  async addLedger(ledger, skipLog = false) {
    const data = {
      name: ledger.name,
      icon: ledger.icon || 'fa-solid fa-book',
      color: ledger.color || '#334A52',
      type: ledger.type || 'personal',
      uuid: ledger.uuid || this.generateUUID(),
      createdAt: Date.now(),
    };
    const r = await this._post('/api/data/ledgers', data);
    if (!skipLog) await this.logChange('add', 'ledgers', r.id, { ...data, id: r.id });
    return r.id;
  }

  async getLedger(id) {
    try { return await this._get(`/api/data/ledgers/${id}`); }
    catch { return null; }
  }

  async getLedgers() {
    try { return await this._get('/api/data/ledgers'); }
    catch { return []; }
  }

  async updateLedger(id, updates, skipLog = false) {
    const updated = await this._put(`/api/data/ledgers/${id}`, updates);
    if (!skipLog) await this.logChange('update', 'ledgers', id, updated);
    return updated;
  }

  async deleteLedger(id, skipLog = false) {
    if (id === 1) throw new Error('不可刪除預設帳本');
    if (!skipLog) {
      const ledger = await this.getLedger(id);
      await this._delete(`/api/data/ledgers/${id}`);
      await this.logChange('delete', 'ledgers', id, { uuid: ledger?.uuid });
    } else {
      await this._delete(`/api/data/ledgers/${id}`);
    }
    if (this.activeLedgerId === id) this.setActiveLedger(1);
    return true;
  }

  // ── Themes ────────────────────────────────────────────────────────────────

  async getInstalledThemes() {
    try { return await this._get('/api/data/themes'); }
    catch { return []; }
  }

  async installTheme(themeData) {
    await this._put(`/api/data/themes/${themeData.id}`, themeData);
  }

  async uninstallTheme(id) {
    await this._delete(`/api/data/themes/${id}`);
  }

  async getTheme(id) {
    try { return await this._get(`/api/data/themes/${id}`); }
    catch { return null; }
  }

  // ── Plugins ───────────────────────────────────────────────────────────────

  async getPlugins() {
    try { return await this._get('/api/data/plugins'); }
    catch { return []; }
  }

  async getPlugin(id) {
    try { return await this._get(`/api/data/plugins/${id}`); }
    catch { return null; }
  }

  async savePlugin(pluginData) {
    await this._put(`/api/data/plugins/${pluginData.id}`, pluginData);
  }

  async deletePlugin(id) {
    await this._delete(`/api/data/plugins/${id}`);
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  async addFile(file) {
    const r = await this._post('/api/data/files', { name: file.name || 'file', type: file.type || 'application/octet-stream', data: file.data, createdAt: Date.now() });
    return r.id;
  }

  async getFile(id) {
    try { return await this._get(`/api/data/files/${id}`); }
    catch { return null; }
  }

  async deleteFile(id) {
    await this._delete(`/api/data/files/${id}`);
    return true;
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  async logChange(operation, storeName, recordId, data) {
    try {
      await this._post('/api/data/sync-log', { operation, storeName, recordId, data, timestamp: Date.now(), deviceId: this._syncDeviceId });
    } catch (e) {
      console.warn('[DataService] logChange error:', e);
    }
  }

  async getChangesSince(sinceTimestamp, options = {}) {
    try {
      const all = await this._get('/api/data/sync-log', { since: sinceTimestamp });
      // Mirror old logic: filter shared vs personal
      const isSharedSync = !!options.sharedLedgerUuid;
      const targetUuid = options.sharedLedgerUuid;
      const allLedgers = await this.getLedgers();
      const sharedUuids = new Set(allLedgers.filter(l => l.isShared).map(l => l.uuid));
      return all.filter(log => {
        let logLedgerUuid = log.data?.ledgerUuid;
        if (!logLedgerUuid && log.storeName === 'ledgers') logLedgerUuid = log.data?.uuid || null;
        if (isSharedSync) return logLedgerUuid === targetUuid;
        if (logLedgerUuid && log.storeName !== 'ledgers') return !sharedUuids.has(logLedgerUuid);
        return true;
      });
    } catch { return []; }
  }

  async clearSyncLog(beforeTimestamp) {
    try {
      const res = await fetch(`/api/data/sync-log?before=${beforeTimestamp}`, { method: 'DELETE', headers: this._headers() });
      if (!res.ok) throw new Error(`DELETE sync-log failed: ${res.status}`);
    } catch (e) {
      console.error('[DataService] clearSyncLog error:', e);
    }
  }

  async getByUUID(storeName, uuid) {
    try { return await this._get(`/api/data/by-uuid/${storeName}/${uuid}`); }
    catch { return null; }
  }

  async exportDataForSync(options = {}) {
    // Reuse the server-side export then filter per sync mode
    const data = await this._get('/api/data/export');
    const isSharedSync = !!options.sharedLedgerUuid;
    const targetUuid = options.sharedLedgerUuid;
    if (isSharedSync) {
      data.ledgers = data.ledgers.filter(l => l.uuid === targetUuid);
    } else {
      data.ledgers = data.ledgers.filter(l => !l.isShared);
    }
    const validIds = new Set(data.ledgers.map(l => l.id));
    data.records = data.records.filter(r => validIds.has(r.ledgerId));
    data.accounts = data.accounts.filter(a => validIds.has(a.ledgerId));
    data.contacts = data.contacts.filter(c => validIds.has(c.ledgerId));
    data.debts = data.debts.filter(d => validIds.has(d.ledgerId));
    data.recurring_transactions = data.recurring_transactions.filter(r => validIds.has(r.ledgerId));
    return data;
  }

  // ── Clear helpers (for import) ────────────────────────────────────────────

  async clearAllRecords() {
    const all = await this.getRecords({ allLedgers: true });
    for (const r of all) await this._delete(`/api/data/records/${r.id}`);
    return true;
  }

  // ── Backward compat stubs ─────────────────────────────────────────────────

  async migrateFromLocalStorage() { /* no-op: data lives on server */ }
}

export default DataService;
