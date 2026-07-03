const InstalledToolBackgroundHost = {
  getManifestText(record) {
    if (!record?.files) return null;
    const base64 = record.files["manifest.json"];
    if (!base64) return null;
    return InstalledToolsRuntime.decodeBase64Utf8(base64);
  },

  getParsedManifest(record) {
    if (typeof InstalledToolsRuntime?.getToolChromeManifest === "function") {
      const manifest = InstalledToolsRuntime.getToolChromeManifest(record);
      return manifest && typeof manifest === "object" ? manifest : null;
    }

    const manifestText = this.getManifestText(record);
    if (!manifestText) return null;

    try {
      return JSON.parse(manifestText);
    } catch {
      return null;
    }
  },

  getBackgroundScriptPath(record) {
    if (typeof InstalledToolsRuntime?.getBackgroundScriptPath === "function") {
      return InstalledToolsRuntime.getBackgroundScriptPath(record);
    }

    const manifest = this.getParsedManifest(record);
    if (!manifest?.background) return null;

    if (typeof manifest.background.service_worker === "string") {
      return InstalledToolChromeBridge.normalizeToolPath(manifest.background.service_worker);
    }

    if (Array.isArray(manifest.background.scripts) && manifest.background.scripts[0]) {
      return InstalledToolChromeBridge.normalizeToolPath(manifest.background.scripts[0]);
    }

    return null;
  },

  async preload() {
    // Background scripts run inside the tool sandbox HTML (CSP-safe), not here.
  },

  unload() {},

  async dispatch() {
    return { handled: false, response: undefined };
  },
};
