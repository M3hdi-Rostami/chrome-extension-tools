const InstalledToolChromeBridge = {
  injectedContentScripts: new Set(),

  normalizeToolPath(filePath) {
    const value = String(filePath || "").trim();
    const extensionMatch = value.match(/^chrome-extension:\/\/[^/]+\/(.+)$/);
    if (extensionMatch) return extensionMatch[1];

    return value.replace(/^\/+/, "");
  },

  getToolFileText(record, filePath) {
    if (!record?.files) return null;

    const normalized = this.normalizeToolPath(filePath);
    const base64 = record.files[normalized];
    if (!base64) return null;

    return InstalledToolsRuntime.decodeBase64Utf8(base64);
  },

  async getToolRecord(toolId) {
    const record = await InstalledToolsStore.getToolRecord(toolId);
    if (!record) {
      throw new Error("محتوای ابزار یافت نشد.");
    }
    return record;
  },

  getContentScriptsFromRecord(record) {
    const entries = [];

    if (Array.isArray(record.manifest?.contentScripts) && record.manifest.contentScripts.length > 0) {
      entries.push(...record.manifest.contentScripts);
    }

    const manifestText = this.getToolFileText(record, "manifest.json");
    if (manifestText) {
      try {
        const manifest = JSON.parse(manifestText);
        if (Array.isArray(manifest.content_scripts)) {
          entries.push(...manifest.content_scripts);
        }
      } catch {
        // ignore invalid manifest
      }
    }

    if (entries.length > 0) {
      return entries;
    }

    return this.discoverLikelyContentScripts(record);
  },

  discoverLikelyContentScripts(record) {
    const files = Object.keys(record.files || {});
    const candidates = [
      "content.js",
      "content/content.js",
      "scripts/content.js",
      "js/content.js",
      "inject.js",
      "injected.js",
      "filler.js",
      "fill.js",
      "page.js",
    ];

    for (const candidate of candidates) {
      if (files.includes(candidate)) {
        return [{ js: [candidate], all_frames: false, world: "ISOLATED" }];
      }
    }

    return [];
  },

  isInjectableTab(tab) {
    if (!tab?.id || !tab.url) return false;
    const blockedPrefixes = [
      "chrome://",
      "chrome-extension://",
      "edge://",
      "about:",
      "devtools://",
      "view-source:",
    ];
    return !blockedPrefixes.some((prefix) => tab.url.startsWith(prefix));
  },

  async getTargetTab(preferredTabId = null) {
    if (preferredTabId) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (this.isInjectableTab(tab)) return tab;
      } catch {
        // fall through
      }
    }

    if (typeof getActiveBrowserTab === "function") {
      const tab = await getActiveBrowserTab();
      if (this.isInjectableTab(tab)) return tab;
    }

    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find((item) => this.isInjectableTab(item));
    if (tab) return tab;

    throw new Error("تب مرورگر مناسبی برای اجرای ابزار یافت نشد. ابتدا یک صفحه وب باز کنید.");
  },

  async queryTabs(queryInfo = {}) {
    const hasActiveFilter = queryInfo.active === true;
    const hasWindowFilter =
      queryInfo.currentWindow === true || queryInfo.lastFocusedWindow === true;
    const isBroadActiveQuery =
      hasActiveFilter ||
      Object.keys(queryInfo).length === 0 ||
      (hasWindowFilter && Object.keys(queryInfo).length <= 2);

    if (isBroadActiveQuery && typeof getActiveBrowserTab === "function") {
      const tab = await getActiveBrowserTab();
      return tab ? [tab] : [];
    }

    const tabs = await chrome.tabs.query(queryInfo);
    return tabs.filter((tab) => this.isInjectableTab(tab));
  },

  buildPathUrlMap(record) {
    const pathMap = InstalledToolsRuntime.createDataUrlMap(record.files || {});
    const result = {};

    for (const [path, url] of pathMap.entries()) {
      result[path] = url;
      result[this.normalizeToolPath(path)] = url;
    }

    return result;
  },

  async ensureRuntimePrelude(tabId, toolId, record, world = "ISOLATED", allFrames = false) {
    const preludeKey = `${toolId}:${tabId}:prelude:${world}:${allFrames ? "all" : "top"}`;
    if (this.injectedContentScripts.has(preludeKey)) return;

    const pathMap = this.buildPathUrlMap(record);

    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      world: world === "MAIN" ? "MAIN" : "ISOLATED",
      func: (assetMap) => {
        if (globalThis.__installedToolGetUrlPatched) return;

        globalThis.__installedToolGetUrlPatched = true;
        const originalGetUrl = chrome.runtime.getURL.bind(chrome.runtime);
        chrome.runtime.getURL = function (path) {
          const normalized = String(path || "").replace(/^\/+/, "");
          return assetMap[normalized] || assetMap[path] || originalGetUrl(path);
        };
      },
      args: [pathMap],
    });

    this.injectedContentScripts.add(preludeKey);
  },

  runScriptInjection(tabId, source, world, allFrames) {
    if (world === "MAIN") {
      return chrome.scripting.executeScript({
        target: { tabId, allFrames },
        world: "MAIN",
        func: (code) => {
          const script = document.createElement("script");
          script.textContent = code;
          (document.head || document.documentElement).appendChild(script);
          script.remove();
        },
        args: [source],
      });
    }

    return chrome.scripting.executeScript({
      target: { tabId, allFrames },
      world: "ISOLATED",
      func: (code) => {
        const execute = new Function(code);
        execute();
      },
      args: [source],
    });
  },

  async injectScriptSource(tabId, source, options = {}) {
    const allFrames = Boolean(options.allFrames);
    const preferredWorld = options.world || "ISOLATED";

    try {
      return await this.runScriptInjection(tabId, source, preferredWorld, allFrames);
    } catch (primaryError) {
      if (preferredWorld !== "MAIN") {
        try {
          return await this.runScriptInjection(tabId, source, "MAIN", allFrames);
        } catch {
          throw primaryError;
        }
      }
      throw primaryError;
    }
  },

  async ensureContentScripts(toolId, tabId, options = {}) {
    const force = Boolean(options.force);
    const injectionKey = `${toolId}:${tabId}`;
    if (!force && this.injectedContentScripts.has(injectionKey)) return;

    const tab = await chrome.tabs.get(tabId);
    if (!this.isInjectableTab(tab)) {
      throw new Error("امکان اجرای ابزار روی این صفحه وجود ندارد.");
    }

    const record = await this.getToolRecord(toolId);
    await this.ensureRuntimePrelude(tabId, toolId, record, "ISOLATED", false);

    const contentScripts = this.getContentScriptsFromRecord(record);

    if (contentScripts.length === 0) {
      this.injectedContentScripts.add(injectionKey);
      return;
    }

    let injectedAny = false;

    for (const entry of contentScripts) {
      const world = entry.world || "ISOLATED";
      const allFrames = Boolean(entry.all_frames);

      await this.ensureRuntimePrelude(tabId, toolId, record, world, allFrames);

      const jsFiles = Array.isArray(entry.js) ? entry.js : [];
      for (const jsFile of jsFiles) {
        const source = this.getToolFileText(record, jsFile);
        if (!source) continue;

        await this.injectScriptSource(tabId, source, { allFrames, world });
        injectedAny = true;
      }

      const cssFiles = Array.isArray(entry.css) ? entry.css : [];
      for (const cssFile of cssFiles) {
        const css = this.getToolFileText(record, cssFile);
        if (!css) continue;

        await chrome.scripting.insertCSS({
          target: { tabId, allFrames: Boolean(entry.all_frames) },
          css,
        });
      }
    }

    if (contentScripts.length > 0 && !injectedAny) {
      throw new Error("فایل‌های content script ابزار یافت نشد.");
    }

    this.injectedContentScripts.add(injectionKey);
  },

  rebuildExecuteScriptFunction(funcSource) {
    const trimmed = String(funcSource || "").trim();
    if (!trimmed) {
      throw new Error("تابع اجرای اسکریپت خالی است.");
    }

    return new Function(`return (${trimmed});`)();
  },

  normalizeExecuteScriptInjection(toolId, injection = {}) {
    const normalized = { ...injection };
    if (normalized.target) {
      normalized.target = { ...normalized.target };
    }

    if (Array.isArray(normalized.files)) {
      normalized.files = normalized.files.map((filePath) => this.normalizeToolPath(filePath));
    }

    return normalized;
  },

  async executeScript(toolId, injection = {}) {
    const normalizedInjection = this.normalizeExecuteScriptInjection(toolId, injection);
    const tabId = normalizedInjection?.target?.tabId;

    if (!tabId) {
      const tab = await this.getTargetTab();
      normalizedInjection.target = {
        ...(normalizedInjection.target || {}),
        tabId: tab.id,
      };
    }

    const resolvedTabId = normalizedInjection.target.tabId;
    await this.ensureContentScripts(toolId, resolvedTabId);

    if (Array.isArray(normalizedInjection.files) && normalizedInjection.files.length > 0) {
      const record = await this.getToolRecord(toolId);
      const world = normalizedInjection.world || "ISOLATED";
      const allFrames = Boolean(normalizedInjection.target?.allFrames);

      await this.ensureRuntimePrelude(resolvedTabId, toolId, record, world, allFrames);

      let lastResult = [];

      for (const filePath of normalizedInjection.files) {
        const source = this.getToolFileText(record, filePath);
        if (!source) {
          throw new Error(`فایل اسکریپت یافت نشد: ${filePath}`);
        }

        lastResult = await this.injectScriptSource(resolvedTabId, source, {
          allFrames: Boolean(normalizedInjection.target?.allFrames),
          world: normalizedInjection.world || "ISOLATED",
        });
      }

      return lastResult;
    }

    if (normalizedInjection.funcSource) {
      const record = await this.getToolRecord(toolId);
      const world = normalizedInjection.world || "ISOLATED";
      const allFrames = Boolean(normalizedInjection.target?.allFrames);
      await this.ensureRuntimePrelude(resolvedTabId, toolId, record, world, allFrames);

      const func = this.rebuildExecuteScriptFunction(normalizedInjection.funcSource);
      return chrome.scripting.executeScript({
        target: normalizedInjection.target,
        world: normalizedInjection.world,
        injectImmediately: normalizedInjection.injectImmediately,
        args: normalizedInjection.args,
        func,
      });
    }

    throw new Error("نوع اجرای اسکریپت پشتیبانی نمی‌شود.");
  },

  async insertCss(toolId, injection = {}) {
    const normalizedInjection = this.normalizeExecuteScriptInjection(toolId, injection);
    const tabId = normalizedInjection?.target?.tabId;

    if (!tabId) {
      const tab = await this.getTargetTab();
      normalizedInjection.target = {
        ...(normalizedInjection.target || {}),
        tabId: tab.id,
      };
    }

    if (typeof normalizedInjection.css === "string" && normalizedInjection.css.trim()) {
      return chrome.scripting.insertCSS({
        target: normalizedInjection.target,
        css: normalizedInjection.css,
      });
    }

    if (Array.isArray(normalizedInjection.files) && normalizedInjection.files.length > 0) {
      const record = await this.getToolRecord(toolId);
      let cssText = "";

      for (const filePath of normalizedInjection.files) {
        const source = this.getToolFileText(record, filePath);
        if (!source) {
          throw new Error(`فایل CSS یافت نشد: ${filePath}`);
        }
        cssText += `${source}\n`;
      }

      return chrome.scripting.insertCSS({
        target: normalizedInjection.target,
        css: cssText,
      });
    }

    throw new Error("محتوای CSS برای درج مشخص نیست.");
  },

  extractRuntimeMessage(args = []) {
    if (args.length === 0) return null;
    if (args.length === 1) return args[0];

    if (typeof args[0] === "string" && args[0].length <= 64) {
      return args[1];
    }

    return args[0];
  },

  async sendRuntimeMessage(toolId, args = []) {
    const message = this.extractRuntimeMessage(args);
    if (message == null) {
      throw new Error("پیام ارسالی خالی است.");
    }

    const tab = await this.getTargetTab();
    await this.ensureContentScripts(toolId, tab.id);

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      await this.ensureContentScripts(toolId, tab.id, { force: true });
      return chrome.tabs.sendMessage(tab.id, message);
    }
  },

  async sendTabMessage(toolId, tabId, message, options) {
    await this.ensureContentScripts(toolId, tabId);

    try {
      if (options !== undefined) {
        return await chrome.tabs.sendMessage(tabId, message, options);
      }
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      await this.ensureContentScripts(toolId, tabId, { force: true });

      if (options !== undefined) {
        return chrome.tabs.sendMessage(tabId, message, options);
      }
      return chrome.tabs.sendMessage(tabId, message);
    }
  },

  async executeLegacyScript(toolId, args = []) {
    let tabId = null;
    let details = {};
    let index = 0;

    if (typeof args[0] === "number") {
      tabId = args[0];
      details = args[1] || {};
      index = 2;
    } else {
      details = args[0] || {};
      tabId = details.tabId || details.target?.tabId || null;
      index = 1;
    }

    const injection = {
      target: {
        tabId,
        allFrames: Boolean(details.allFrames),
        frameIds: details.frameId != null ? [details.frameId] : undefined,
      },
      world: details.world || "ISOLATED",
    };

    if (details.file) {
      injection.files = [this.normalizeToolPath(details.file)];
    } else if (details.files) {
      injection.files = details.files.map((filePath) => this.normalizeToolPath(filePath));
    } else if (typeof details.code === "string") {
      injection.funcSource = `function() { ${details.code} }`;
    } else if (typeof details.func === "function") {
      injection.funcSource = details.func.toString();
      injection.args = details.args;
    }

    const result = await this.executeScript(toolId, injection);
    return Array.isArray(result) ? result.map((entry) => entry.result) : result;
  },

  async preInjectForTool(toolId) {
    const tab = await this.getTargetTab();
    await this.ensureContentScripts(toolId, tab.id, { force: true });
    return tab;
  },

  async invoke(toolId, path, args = []) {
    switch (path) {
      case "tabs.query":
        return this.queryTabs(args[0]);

      case "tabs.get":
        return chrome.tabs.get(args[0]);

      case "tabs.create":
        return chrome.tabs.create(args[0]);

      case "tabs.sendMessage":
        return this.sendTabMessage(toolId, args[0], args[1], args[2]);

      case "tabs.executeScript":
        return this.executeLegacyScript(toolId, args);

      case "scripting.executeScript":
        return this.executeScript(toolId, args[0]);

      case "scripting.insertCSS":
        return this.insertCss(toolId, args[0]);

      case "runtime.sendMessage":
        return this.sendRuntimeMessage(toolId, args);

      default:
        throw new Error(`Chrome API پشتیبانی نمی‌شود: ${path}`);
    }
  },

  clearInjectionCache(toolId = null) {
    if (!toolId) {
      this.injectedContentScripts.clear();
      return;
    }

    const prefix = `${toolId}:`;
    for (const key of [...this.injectedContentScripts]) {
      if (key.startsWith(prefix)) {
        this.injectedContentScripts.delete(key);
      }
    }
  },
};
