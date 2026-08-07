const ExtensionUpdater = {
  get config() {
    return typeof EXTENSION_UPDATE_CONFIG !== "undefined" ? EXTENSION_UPDATE_CONFIG : null;
  },

  getCurrentVersion() {
    if (!chrome?.runtime?.getManifest) return "0.0.0";
    return chrome.runtime.getManifest().version || "0.0.0";
  },

  getRepoApiBase() {
    const { repoOwner, repoName } = this.config;
    return `https://api.github.com/repos/${repoOwner}/${repoName}`;
  },

  getManifestUrl(ref) {
    const { repoOwner, repoName, branch } = this.config;
    return `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${ref || branch}/manifest.json`;
  },

  getZipUrl(ref) {
    const { repoOwner, repoName, branch } = this.config;
    return `https://codeload.github.com/${repoOwner}/${repoName}/zip/${ref || branch}`;
  },

  getRepoUrl() {
    const { repoOwner, repoName } = this.config;
    return `https://github.com/${repoOwner}/${repoName}`;
  },

  bust(url) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_=${Date.now()}`;
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

  async fetchLatestCommitSha() {
    if (!this.config) {
      throw new Error("تنظیمات به‌روزرسانی یافت نشد.");
    }

    const { branch } = this.config;
    const response = await fetch(
      this.bust(`${this.getRepoApiBase()}/commits/${encodeURIComponent(branch)}`),
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات نسخه جدید");
    }

    const payload = await response.json();
    const sha = payload?.sha;
    if (!sha) {
      throw new Error("خطا در دریافت اطلاعات نسخه جدید");
    }

    return sha;
  },

  async fetchLatestVersion() {
    if (!this.config) {
      throw new Error("تنظیمات به‌روزرسانی یافت نشد.");
    }

    // Branch URLs on raw.githubusercontent.com are CDN-cached (~5 min).
    // Resolve the tip commit via API, then fetch that immutable SHA.
    const commitSha = await this.fetchLatestCommitSha();
    const response = await fetch(this.bust(this.getManifestUrl(commitSha)), {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات نسخه جدید");
    }

    const manifest = await response.json();
    return {
      version: manifest.version || "0.0.0",
      commitSha,
    };
  },

  async checkForUpdate() {
    const currentVersion = this.getCurrentVersion();
    const { version: latestVersion, commitSha } = await this.fetchLatestVersion();
    const comparison = this.compareVersions(currentVersion, latestVersion);

    return {
      currentVersion,
      latestVersion,
      commitSha,
      hasUpdate: comparison > 0,
      isDowngrade: comparison < 0,
    };
  },

  downloadLatestZip(commitSha) {
    return new Promise((resolve, reject) => {
      if (!chrome?.downloads?.download) {
        reject(new Error("دسترسی دانلود در دسترس نیست."));
        return;
      }

      const filename = `chrome-extension-tools-update-${Date.now()}.zip`;

      chrome.downloads.download(
        {
          url: this.bust(this.getZipUrl(commitSha)),
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
