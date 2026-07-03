const InstalledToolStorageProxy = {
  areaStorageKey(toolId) {
    return `installed-tool-storage:${toolId}`;
  },

  normalizeKeys(keys) {
    if (keys == null) return { list: null, defaults: null };
    if (typeof keys === "string") return { list: [keys], defaults: null };
    if (Array.isArray(keys)) return { list: keys, defaults: null };
    return { list: Object.keys(keys), defaults: keys };
  },

  async readArea(toolId) {
    const storageKey = this.areaStorageKey(toolId);
    const result = await chrome.storage.local.get([storageKey]);
    return result[storageKey] && typeof result[storageKey] === "object" ? result[storageKey] : {};
  },

  async writeArea(toolId, area) {
    const storageKey = this.areaStorageKey(toolId);
    await chrome.storage.local.set({ [storageKey]: area });
  },

  async get(toolId, keys) {
    const normalized = this.normalizeKeys(keys);
    const area = await this.readArea(toolId);
    const result = {};

    if (normalized.list) {
      normalized.list.forEach((key) => {
        if (area[key] !== undefined) result[key] = area[key];
      });
    } else {
      Object.assign(result, area);
    }

    if (normalized.defaults) {
      Object.keys(normalized.defaults).forEach((key) => {
        if (result[key] === undefined) result[key] = normalized.defaults[key];
      });
    }

    return result;
  },

  async set(toolId, items) {
    const area = await this.readArea(toolId);
    Object.assign(area, items || {});
    await this.writeArea(toolId, area);
  },

  async remove(toolId, keys) {
    const keyList = typeof keys === "string" ? [keys] : keys || [];
    const area = await this.readArea(toolId);
    keyList.forEach((key) => {
      delete area[key];
    });
    await this.writeArea(toolId, area);
  },

  async clear(toolId) {
    await this.writeArea(toolId, {});
  },

  createArea(toolId) {
    return {
      get: (keys, callback) => {
        const promise = this.get(toolId, keys);
        if (typeof callback === "function") {
          promise.then((result) => callback(result));
        }
        return promise;
      },
      set: (items, callback) => {
        const promise = this.set(toolId, items);
        if (typeof callback === "function") {
          promise.then(() => callback());
        }
        return promise;
      },
      remove: (keys, callback) => {
        const promise = this.remove(toolId, keys);
        if (typeof callback === "function") {
          promise.then(() => callback());
        }
        return promise;
      },
      clear: (callback) => {
        const promise = this.clear(toolId);
        if (typeof callback === "function") {
          promise.then(() => callback());
        }
        return promise;
      },
    };
  },
};
