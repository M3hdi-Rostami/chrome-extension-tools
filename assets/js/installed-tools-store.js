const INSTALLED_TOOLS_DB_NAME = "superExtensionInstalledTools";
const INSTALLED_TOOLS_DB_VERSION = 1;
const INSTALLED_TOOLS_META_KEY = "installedToolsMeta";

const InstalledToolsStore = {
  async openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(INSTALLED_TOOLS_DB_NAME, INSTALLED_TOOLS_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("tools")) {
          db.createObjectStore("tools", { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async getMetaList() {
    try {
      if (chrome?.storage?.local) {
        const result = await chrome.storage.local.get([INSTALLED_TOOLS_META_KEY]);
        return result[INSTALLED_TOOLS_META_KEY] || [];
      }
    } catch {
      // fall through
    }

    try {
      const raw = localStorage.getItem(INSTALLED_TOOLS_META_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async saveMetaList(metaList) {
    try {
      if (chrome?.storage?.local) {
        await chrome.storage.local.set({ [INSTALLED_TOOLS_META_KEY]: metaList });
        return;
      }
    } catch {
      // fall through
    }

    localStorage.setItem(INSTALLED_TOOLS_META_KEY, JSON.stringify(metaList));
  },

  async listMeta() {
    const metaList = await this.getMetaList();
    return metaList.map((item) => ({ ...item, custom: true }));
  },

  async getToolRecord(id) {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tools", "readonly");
      const request = tx.objectStore("tools").get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },

  async saveTool(record) {
    const db = await this.openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("tools", "readwrite");
      tx.objectStore("tools").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const metaList = await this.getMetaList();
    const nextMeta = {
      id: record.id,
      title: record.title,
      description: record.description,
      icon: record.icon,
      installedAt: record.installedAt,
      custom: true,
    };

    const index = metaList.findIndex((item) => item.id === record.id);
    if (index === -1) {
      metaList.push(nextMeta);
    } else {
      metaList[index] = nextMeta;
    }

    await this.saveMetaList(metaList);
  },

  async deleteTool(id) {
    const db = await this.openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("tools", "readwrite");
      tx.objectStore("tools").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const metaList = await this.getMetaList();
    await this.saveMetaList(metaList.filter((item) => item.id !== id));
  },

  async exists(id) {
    const metaList = await this.getMetaList();
    return metaList.some((item) => item.id === id);
  },
};
