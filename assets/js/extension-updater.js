const ExtensionUpdater = {
  DIR_DB_NAME: "extension-updater-db",
  DIR_STORE_NAME: "handles",
  DIR_KEY: "install-directory",
  PRESERVE_ROOT_NAMES: new Set([".git", ".github", ".gitignore", "README.md"]),

  get config() {
    return typeof EXTENSION_UPDATE_CONFIG !== "undefined" ? EXTENSION_UPDATE_CONFIG : null;
  },

  getCurrentVersion() {
    if (!chrome?.runtime?.getManifest) return "0.0.0";
    return chrome.runtime.getManifest().version || "0.0.0";
  },

  getManifestUrl() {
    const { repoOwner, repoName, branch } = this.config;
    return `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/manifest.json`;
  },

  getZipUrl() {
    const { repoOwner, repoName, branch } = this.config;
    return `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/${branch}.zip`;
  },

  getRepoUrl() {
    const { repoOwner, repoName } = this.config;
    return `https://github.com/${repoOwner}/${repoName}`;
  },

  compareVersions(current, latest) {
    const currentParts = String(current).split(".").map((part) => Number(part) || 0);
    const latestParts = String(latest).split(".").map((part) => Number(part) || 0);
    const length = Math.max(currentParts.length, latestParts.length);

    for (let index = 0; index < length; index += 1) {
      const currentValue = currentParts[index] || 0;
      const latestValue = latestParts[index] || 0;
      if (latestValue > currentValue) return 1;
      if (latestValue < currentValue) return -1;
    }

    return 0;
  },

  async fetchLatestVersion() {
    if (!this.config) {
      throw new Error("تنظیمات به‌روزرسانی یافت نشد.");
    }

    const response = await fetch(this.getManifestUrl(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات نسخه جدید");
    }

    const manifest = await response.json();
    return manifest.version || "0.0.0";
  },

  async checkForUpdate() {
    const currentVersion = this.getCurrentVersion();
    const latestVersion = await this.fetchLatestVersion();
    const comparison = this.compareVersions(currentVersion, latestVersion);

    return {
      currentVersion,
      latestVersion,
      hasUpdate: comparison > 0,
      isDowngrade: comparison < 0,
    };
  },

  openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DIR_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.DIR_STORE_NAME)) {
          db.createObjectStore(this.DIR_STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("باز کردن پایگاه‌داده ناموفق بود."));
    });
  },

  async saveDirectoryHandle(handle) {
    const db = await this.openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.DIR_STORE_NAME, "readwrite");
      tx.objectStore(this.DIR_STORE_NAME).put(handle, this.DIR_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("ذخیره دسترسی پوشه ناموفق بود."));
      };
    });
  },

  async loadDirectoryHandle() {
    const db = await this.openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.DIR_STORE_NAME, "readonly");
      const request = tx.objectStore(this.DIR_STORE_NAME).get(this.DIR_KEY);
      request.onsuccess = () => {
        db.close();
        resolve(request.result || null);
      };
      request.onerror = () => {
        db.close();
        reject(request.error || new Error("خواندن دسترسی پوشه ناموفق بود."));
      };
    });
  },

  async ensurePermission(handle) {
    if (!handle?.queryPermission || !handle?.requestPermission) return false;

    const options = { mode: "readwrite" };
    const current = await handle.queryPermission(options);
    if (current === "granted") return true;

    const next = await handle.requestPermission(options);
    return next === "granted";
  },

  async validateExtensionDirectory(handle) {
    let manifestHandle;
    try {
      manifestHandle = await handle.getFileHandle("manifest.json");
    } catch {
      throw new Error(
        "پوشه انتخاب‌شده معتبر نیست. پوشه اصلی اکستنشن را انتخاب کنید.",
      );
    }

    const file = await manifestHandle.getFile();
    const text = await file.text();
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new Error("فایل manifest.json در پوشه انتخاب‌شده نامعتبر است.");
    }

    const expectedName = chrome?.runtime?.getManifest?.()?.name;
    if (expectedName && manifest.name && manifest.name !== expectedName) {
      throw new Error(
        `پوشه متعلق به «${manifest.name}» است، نه «${expectedName}».`,
      );
    }

    return manifest;
  },

  async pickInstallDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("مرورگر از به‌روزرسانی خودکار پشتیبانی نمی‌کند.");
    }

    const handle = await window.showDirectoryPicker({
      id: "developer-widgets-install-dir",
      mode: "readwrite",
    });

    await this.validateExtensionDirectory(handle);
    await this.saveDirectoryHandle(handle);
    return handle;
  },

  async downloadZipWithProgress(onProgress) {
    const response = await fetch(this.getZipUrl(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error("دریافت نسخه جدید ناموفق بود.");
    }

    const total = Number(response.headers.get("Content-Length")) || 0;
    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = await response.arrayBuffer();
      if (typeof onProgress === "function") onProgress(1);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (typeof onProgress === "function") {
        onProgress(total > 0 ? Math.min(1, received / total) : 0.5);
      }
    }

    if (typeof onProgress === "function") onProgress(1);

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return merged.buffer;
  },

  normalizeZipFiles(zip) {
    const files = new Map();

    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!path || path.endsWith("/")) return;
      files.set(path, entry);
    });

    const paths = [...files.keys()];
    if (paths.length === 0) return files;

    if (files.has("manifest.json")) return files;

    const roots = [...new Set(paths.map((path) => path.split("/")[0]))];
    if (roots.length !== 1) return files;

    const root = roots[0];
    if (!paths.every((path) => path.startsWith(`${root}/`))) return files;

    const normalized = new Map();
    for (const [path, entry] of files.entries()) {
      normalized.set(path.slice(root.length + 1), entry);
    }

    return normalized;
  },

  async ensureDirectory(rootHandle, parts) {
    let dir = rootHandle;
    for (const part of parts) {
      if (!part || part === "." || part === "..") continue;
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return dir;
  },

  async writeZipEntry(rootHandle, relativePath, entry) {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) return;
    if (this.PRESERVE_ROOT_NAMES.has(parts[0]) && parts[0] !== "README.md") {
      return;
    }

    const fileName = parts.pop();
    const dir = await this.ensureDirectory(rootHandle, parts);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const data = await entry.async("uint8array");
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  },

  async applyZipToDirectory(arrayBuffer, rootHandle, onProgress) {
    if (typeof JSZip === "undefined") {
      throw new Error("کتابخانه JSZip در دسترس نیست.");
    }

    const zip = await JSZip.loadAsync(arrayBuffer);
    const files = this.normalizeZipFiles(zip);

    if (!files.has("manifest.json")) {
      throw new Error("فایل‌های دریافتی ناقص است.");
    }

    const entries = [...files.entries()];
    const total = entries.length || 1;

    for (let index = 0; index < entries.length; index += 1) {
      const [relativePath, entry] = entries[index];
      await this.writeZipEntry(rootHandle, relativePath, entry);
      if (typeof onProgress === "function") {
        onProgress((index + 1) / total);
      }
    }
  },

  mapProgress(stage, ratio) {
    const ranges = {
      prepare: [0, 12],
      check: [12, 20],
      download: [20, 55],
      extract: [55, 98],
      finalize: [98, 100],
    };
    const [start, end] = ranges[stage] || [0, 100];
    const value = start + (end - start) * Math.min(1, Math.max(0, ratio || 0));
    return Math.round(value);
  },

  async tryGetReadyDirectoryHandle() {
    let handle = null;
    try {
      handle = await this.loadDirectoryHandle();
    } catch {
      return null;
    }

    if (!handle || !(await this.ensurePermission(handle))) return null;

    try {
      await this.validateExtensionDirectory(handle);
      return handle;
    } catch {
      return null;
    }
  },

  async applyUpdate({ onProgress, onStatus } = {}) {
    const report = (percent, message) => {
      if (typeof onProgress === "function") onProgress(percent);
      if (message && typeof onStatus === "function") onStatus(message);
    };

    report(this.mapProgress("prepare", 0.15), "آماده‌سازی به‌روزرسانی...");
    let dirHandle = await this.tryGetReadyDirectoryHandle();
    if (!dirHandle) {
      report(
        this.mapProgress("prepare", 0.45),
        "برای اعمال به‌روزرسانی، پوشه اکستنشن را انتخاب کنید.",
      );
      try {
        dirHandle = await this.pickInstallDirectory();
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new Error(
          error?.message ||
            "اجازه دسترسی لازم است. دوباره دکمه را بزنید و پوشه را انتخاب کنید.",
        );
      }
    }
    report(this.mapProgress("prepare", 1));

    report(this.mapProgress("check", 0.2), "در حال بررسی نسخه جدید...");
    const result = await this.checkForUpdate();
    report(this.mapProgress("check", 1));

    if (!result.hasUpdate) {
      report(100, `شما آخرین نسخه را دارید (v${result.latestVersion}).`);
      return { ...result, applied: false };
    }

    report(
      this.mapProgress("download", 0),
      `نسخه v${result.latestVersion} یافت شد. در حال دریافت...`,
    );

    const zipBuffer = await this.downloadZipWithProgress((ratio) => {
      report(this.mapProgress("download", ratio), "در حال دریافت نسخه جدید...");
    });

    report(this.mapProgress("extract", 0), "در حال اعمال فایل‌های جدید...");

    await this.applyZipToDirectory(zipBuffer, dirHandle, (ratio) => {
      report(this.mapProgress("extract", ratio), "در حال نوشتن فایل‌ها...");
    });

    report(this.mapProgress("finalize", 0.5), "در حال نهایی‌سازی...");

    if (chrome?.storage?.local) {
      await chrome.storage.local.set({
        extensionUpdateApplied: {
          version: result.latestVersion,
          at: Date.now(),
        },
      });
    }

    report(100, `به‌روزرسانی v${result.latestVersion} اعمال شد. در حال راه‌اندازی مجدد...`);

    return { ...result, applied: true };
  },

  reloadExtension() {
    if (chrome?.runtime?.reload) {
      chrome.runtime.reload();
      return;
    }

    window.location.reload();
  },

  openRepositoryPage() {
    window.open(this.getRepoUrl(), "_blank", "noopener,noreferrer");
  },
};
