/**
 * PluginStorage — sandboxed per-plugin key-value store backed by the server API.
 * Keys are namespaced by pluginId; data is persisted in the plugins table on the server.
 */
export class PluginStorage {
    constructor(pluginId, dataService) {
        if (!pluginId) throw new Error('PluginStorage requires a pluginId.');
        if (!dataService) throw new Error('PluginStorage requires a DataService instance.');
        if (!/^[a-zA-Z0-9._-]+$/.test(pluginId)) {
            console.warn(`PluginStorage: Sub-optimal pluginId format: "${pluginId}".`);
        }
        this.pluginId = pluginId;
        this.dataService = dataService;
        this.prefix = `plugin_${pluginId}_`;
        this.cache = Object.create(null);
        this.saveTimeout = null;
        this.savePromise = null;
        this.savePromiseResolve = null;
    }

    async init() {
        let pluginData = null;
        try {
            pluginData = await this.dataService.getPlugin(this.pluginId);
        } catch (e) {
            console.error(`[PluginStorage] Failed to read plugin data for ${this.pluginId}`, e);
        }

        if (pluginData?.storage) {
            this.cache = Object.assign(Object.create(null), pluginData.storage);
        } else {
            this.cache = Object.create(null);
        }

        // Migrate from localStorage if needed
        let migrated = false;
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const lsKey = localStorage.key(i);
            if (lsKey?.startsWith(this.prefix)) {
                const originalKey = lsKey.substring(this.prefix.length);
                const value = localStorage.getItem(lsKey);
                if (!(originalKey in this.cache)) {
                    this.cache[originalKey] = value;
                    migrated = true;
                }
                keysToRemove.push(lsKey);
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        if (migrated) await this._saveToDB();
    }

    async _saveToDB() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        if (!this.savePromise) {
            this.savePromise = new Promise(resolve => { this.savePromiseResolve = resolve; });
        }
        const currentResolve = this.savePromiseResolve;
        this.saveTimeout = setTimeout(async () => {
            this.saveTimeout = null;
            this.savePromise = null;
            this.savePromiseResolve = null;
            try {
                const existing = await this.dataService.getPlugin(this.pluginId);
                if (existing) {
                    await this.dataService.savePlugin({ ...existing, storage: { ...this.cache } });
                }
            } catch (e) {
                console.error(`[PluginStorage] Failed to save for ${this.pluginId}`, e);
            } finally {
                if (currentResolve) currentResolve();
            }
        }, 50);
        return this.savePromise;
    }

    setItem(key, value) {
        this.cache[key] = String(value);
        this._saveToDB();
    }

    getItem(key) {
        return key in this.cache ? this.cache[key] : null;
    }

    removeItem(key) {
        if (key in this.cache) {
            delete this.cache[key];
            this._saveToDB();
        }
    }

    clear() {
        this.cache = Object.create(null);
        this._saveToDB();
    }

    setJSON(key, value) {
        try { this.setItem(key, JSON.stringify(value)); }
        catch (e) { console.error(`[PluginStorage] Error saving JSON for ${key}:`, e); }
    }

    getJSON(key) {
        const value = this.getItem(key);
        if (value === null) return null;
        try { return JSON.parse(value); }
        catch (e) { console.error(`[PluginStorage] Error parsing JSON for ${key}:`, e); return null; }
    }
}
