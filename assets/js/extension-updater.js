const ExtensionUpdater = {
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

  downloadLatestZip() {
    return new Promise((resolve, reject) => {
      if (!chrome?.downloads?.download) {
        reject(new Error("دسترسی دانلود در دسترس نیست."));
        return;
      }

      const filename = `chrome-extension-tools-update-${Date.now()}.zip`;

      chrome.downloads.download(
        {
          url: this.getZipUrl(),
          filename,
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve({ downloadId, filename });
        },
      );
    });
  },

  openExtensionsPage() {
    if (chrome?.tabs?.create) {
      chrome.tabs.create({ url: "chrome://extensions" });
      return;
    }

    window.open("chrome://extensions", "_blank");
  },

  openRepositoryPage() {
    window.open(this.getRepoUrl(), "_blank", "noopener,noreferrer");
  },
};
