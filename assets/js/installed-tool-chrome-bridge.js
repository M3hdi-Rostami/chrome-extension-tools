const InstalledToolChromeBridge = {
  injectedContentScripts: new Set(),
  preferredTabId: null,
  activeToolId: null,
  pendingScriptFiles: new Map(),

  setPreferredTabId(tabId) {
    this.preferredTabId = typeof tabId === "number" ? tabId : null;
  },

  clearPreferredTabId() {
    this.preferredTabId = null;
  },

  setActiveToolId(toolId) {
    this.activeToolId = toolId || null;
  },

  clearActiveToolId() {
    this.activeToolId = null;
  },

  normalizeToolPath(filePath) {
    const value = String(filePath || "").trim();
    const extensionMatch = value.match(/^chrome-extension:\/\/[^/]+\/(.+)$/);
    if (extensionMatch) return extensionMatch[1];

    return value.replace(/^\/+/, "");
  },

  getToolFileText(record, filePath) {
    if (!record?.files) return null;

    const normalized = this.normalizeToolPath(filePath);
    let base64 = record.files[normalized];

    if (!base64) {
      const suffixMatch = Object.keys(record.files).find(
        (key) => key === normalized || key.endsWith(`/${normalized}`),
      );
      if (suffixMatch) base64 = record.files[suffixMatch];
    }

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

  registeredContentScripts: new Map(),

  normalizeContentScriptEntry(entry) {
    return {
      js: Array.isArray(entry?.js) ? entry.js.map((p) => this.normalizeToolPath(p)) : [],
      css: Array.isArray(entry?.css) ? entry.css.map((p) => this.normalizeToolPath(p)) : [],
      all_frames: entry?.all_frames !== false,
      world: entry?.world || "ISOLATED",
    };
  },

  getContentScriptsFromRecord(record) {
    const entries = [];
    const seen = new Set();

    const pushEntry = (entry) => {
      const normalized = this.normalizeContentScriptEntry(entry);
      if (normalized.js.length === 0 && normalized.css.length === 0) return;

      const key = JSON.stringify(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(normalized);
    };

    if (Array.isArray(record.manifest?.contentScripts)) {
      record.manifest.contentScripts.forEach(pushEntry);
    }

    const manifestText = this.getToolFileText(record, "manifest.json");
    if (manifestText) {
      try {
        const manifest = JSON.parse(manifestText);
        if (Array.isArray(manifest.content_scripts)) {
          manifest.content_scripts.forEach(pushEntry);
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
    const manifest = InstalledToolBackgroundHost?.getParsedManifest?.(record) || null;
    const reserved = new Set(
      [
        record.manifest?.entry,
        manifest?.action?.default_popup,
        manifest?.browser_action?.default_popup,
        manifest?.side_panel?.default_path,
        InstalledToolBackgroundHost?.getBackgroundScriptPath?.(record),
        "options.html",
        "options.js",
      ]
        .filter(Boolean)
        .map((path) => this.normalizeToolPath(path)),
    );

    const jsFiles = files
      .map((path) => this.normalizeToolPath(path))
      .filter((path) => {
        if (!path.endsWith(".js")) return false;
        if (reserved.has(path)) return false;
        if (/(^|\/)(popup|background|service[-_]?worker|options|devtools|webpack|vendor|bundle)\b/i.test(path)) {
          return false;
        }
        return true;
      });

    const prioritized = jsFiles.filter((path) =>
      /(content|inject|fill|filler|page[-_]?script|dom|autofill)/i.test(path),
    );
    const selected = prioritized.length > 0 ? prioritized : jsFiles;

    if (selected.length === 0) {
      return [];
    }

    return [
      {
        js: selected,
        all_frames: true,
        world: "ISOLATED",
      },
    ];
  },

  isInjectableTab(tab) {
    if (typeof isInjectableBrowserTab === "function") {
      return isInjectableBrowserTab(tab);
    }

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
    if (typeof getActiveBrowserTab === "function") {
      try {
        const freshTab = await getActiveBrowserTab();
        if (this.isInjectableTab(freshTab)) {
          this.preferredTabId = freshTab.id;
          return freshTab;
        }
      } catch {
        // fall through
      }
    }

    const tabId = preferredTabId ?? this.preferredTabId;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (this.isInjectableTab(tab)) return tab;
      } catch {
        // fall through
      }
    }

    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find((item) => this.isInjectableTab(item));
    if (tab) return tab;

    const normalTabs = await chrome.tabs.query({ windowType: "normal" });
    const fallback = normalTabs.find((item) => this.isInjectableTab(item));
    if (fallback) return fallback;

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

  sortInjectedScriptFiles(filePaths) {
    const score = (filePath) => {
      const path = String(filePath || "");
      if (/content\.js$/i.test(path)) return 1000;
      if (/^lib\//i.test(path) || /\/lib\//i.test(path)) return 100;
      return 500;
    };

    return [...filePaths].sort((a, b) => score(a) - score(b));
  },

  getPageMessageBridgeSource() {
    return "";
  },

  appendContentScriptDispatchHook(source, filePath) {
    if (!/\/content\.js$/i.test(String(filePath || ""))) {
      return source;
    }

    const hook = `
  globalThis.__installedToolDispatchPageMessage = function (message) {
    var msg = message || {};
    var opts = {
      lang: msg.lang || 'en',
      mode: msg.mode || 'fake',
      profile: msg.profile || null,
      onlyEmpty: !!msg.onlyEmpty
    };
    var n = 0;
    try {
      if (msg.action === 'fill') { n = fillAll(opts); toast(label(opts.lang, 'filled', n)); }
      else if (msg.action === 'clear') { n = clearAll(); toast(label(opts.lang, 'cleared', n)); }
      else if (msg.action === 'fillField') { n = fillSingle(window.__formFillerTarget, opts); toast(label(opts.lang, 'filled', n)); }
    } catch (error) {}
    return { count: n };
  };
`;

    if (/\}\)\(\);\s*$/s.test(source)) {
      return source.replace(/\}\)\(\);\s*$/s, `${hook}\n})();`);
    }

    return `${source}\n${hook}`;
  },

  combineToolScriptSources(record, filePaths) {
    const parts = [];

    for (const filePath of this.sortInjectedScriptFiles(filePaths)) {
      let source = this.getToolFileText(record, filePath);
      if (!source) {
        throw new Error(`فایل اسکریپت یافت نشد: ${filePath}`);
      }
      source = this.appendContentScriptDispatchHook(source, filePath);
      parts.push(`;// ${filePath}\n${source}`);
    }

    return parts.join("\n");
  },

  runScriptInjection(tabId, source, world, allFrames) {
    const injectionTarget = { tabId, allFrames };

    if (world === "MAIN") {
      return chrome.scripting.executeScript({
        target: injectionTarget,
        world: "MAIN",
        injectImmediately: true,
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
      target: injectionTarget,
      world: "ISOLATED",
      injectImmediately: true,
      func: (code) => {
        (0, eval)(code);
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

  getDefaultInjectableFiles(record) {
    const entries = this.getContentScriptsFromRecord(record);
    const files = new Set();

    for (const entry of entries) {
      for (const filePath of entry.js || []) {
        files.add(this.normalizeToolPath(filePath));
      }
    }

    return [...files];
  },

  async injectToolBundle(toolId, tabId, filePaths = null) {
    const record = await this.getToolRecord(toolId);
    const files =
      filePaths ||
      this.pendingScriptFiles.get(toolId) ||
      this.getDefaultInjectableFiles(record);

    if (!files.length) return false;

    const combined = this.combineToolScriptSources(record, files);
    await this.injectScriptSource(tabId, combined, { allFrames: false, world: "ISOLATED" });
    return true;
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
      if (jsFiles.length > 0) {
        const combined = this.combineToolScriptSources(record, jsFiles);
        await this.injectScriptSource(tabId, combined, { allFrames, world });
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

  async injectBundledDependencies(tabId, record) {
    const candidates = Object.keys(record.files || {})
      .map((path) => this.normalizeToolPath(path))
      .filter((path) => /\.m?js$/i.test(path) && /(faker|locale|lib\/|vendor\/)/i.test(path));

    for (const filePath of candidates) {
      const source = this.getToolFileText(record, filePath);
      if (!source) continue;

      try {
        await this.injectScriptSource(tabId, source, { allFrames: true, world: "ISOLATED" });
      } catch (error) {
        console.warn("Installed tool dependency inject skipped:", filePath, error);
      }
    }
  },

  rebuildExecuteScriptFunction(funcSource) {
    const trimmed = String(funcSource || "").trim();
    if (!trimmed) {
      throw new Error("تابع اجرای اسکریپت خالی است.");
    }

    return new Function(`return (${trimmed});`)();
  },

  buildComposedFunctionScript(funcSource, args = []) {
    const argsLiteral = JSON.stringify(args ?? []);
    return `(function () {
  var __installedToolArgs = ${argsLiteral};
  var __installedToolFn = (${funcSource});
  if (typeof __installedToolFn !== "function") return;
  return __installedToolFn.apply(null, __installedToolArgs);
})();`;
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
    if (Array.isArray(injection)) {
      let combined = [];
      for (const item of injection) {
        const result = await this.executeScript(toolId, item);
        if (Array.isArray(result)) combined = combined.concat(result);
      }
      return combined;
    }

    const normalizedInjection = this.normalizeExecuteScriptInjection(toolId, injection);

    if (typeof normalizedInjection.code === "string" && normalizedInjection.code.trim()) {
      normalizedInjection.funcSource = `function() { ${normalizedInjection.code} }`;
      delete normalizedInjection.code;
    }

    const tabId = normalizedInjection?.target?.tabId;

    if (!tabId) {
      const tab = await this.getTargetTab();
      normalizedInjection.target = {
        ...(normalizedInjection.target || {}),
        tabId: tab.id,
      };
    }

    const resolvedTabId = normalizedInjection.target.tabId;

    if (Array.isArray(normalizedInjection.files) && normalizedInjection.files.length > 0) {
      this.pendingScriptFiles.set(toolId, normalizedInjection.files);

      const record = await this.getToolRecord(toolId);
      const world = normalizedInjection.world || "ISOLATED";
      const allFrames = Boolean(normalizedInjection.target?.allFrames);

      await this.ensureRuntimePrelude(resolvedTabId, toolId, record, world, allFrames);

      const combined = this.combineToolScriptSources(record, normalizedInjection.files);
      return this.injectScriptSource(resolvedTabId, combined, { allFrames, world });
    }

    await this.ensureContentScripts(toolId, resolvedTabId);

    if (normalizedInjection.funcSource) {
      const record = await this.getToolRecord(toolId);
      const world = normalizedInjection.world || "ISOLATED";
      const allFrames = Boolean(normalizedInjection.target?.allFrames);
      await this.ensureRuntimePrelude(resolvedTabId, toolId, record, world, allFrames);
      await this.injectBundledDependencies(resolvedTabId, record);

      const composed = this.buildComposedFunctionScript(
        normalizedInjection.funcSource,
        normalizedInjection.args,
      );

      return this.injectScriptSource(resolvedTabId, composed, { allFrames, world });
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

  async sendMessageToContentScript(toolId, message) {
    if (message == null) {
      throw new Error("پیام ارسالی خالی است.");
    }

    const tab = await this.getTargetTab();
    await this.ensureContentScripts(toolId, tab.id);

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      await this.ensureContentScripts(toolId, tab.id, { force: true });

      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (retryError) {
        return this.dispatchMessageViaInjection(tab.id, message);
      }
    }
  },

  async dispatchMessageViaInjection(tabId, message) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      injectImmediately: true,
      func: (payload) => {
        if (typeof globalThis.__installedToolDispatchPageMessage === "function") {
          return globalThis.__installedToolDispatchPageMessage(payload);
        }

        const listeners = globalThis.__installedToolRuntimeMessageListeners;
        if (!Array.isArray(listeners) || listeners.length === 0) {
          return undefined;
        }

        let response;
        const sendResponse = (value) => {
          response = value;
          return true;
        };

        for (const listener of listeners) {
          try {
            listener(payload, {}, sendResponse);
            if (response !== undefined) return response;
          } catch {
            // try next listener
          }
        }

        return response;
      },
      args: [message],
    });

    const frameResults = Array.isArray(results) ? results : [];
    for (const entry of frameResults) {
      if (entry?.result !== undefined) return entry.result;
    }

    return undefined;
  },

  async installMessageListenerBridge(tabId) {
    const bridgeKey = `message-bridge:${tabId}`;
    if (this.injectedContentScripts.has(bridgeKey)) return;

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      injectImmediately: true,
      func: () => {
        if (globalThis.__installedToolMessageBridgeReady) return;
        globalThis.__installedToolMessageBridgeReady = true;

        if (!Array.isArray(globalThis.__installedToolRuntimeMessageListeners)) {
          globalThis.__installedToolRuntimeMessageListeners = [];
        }

        const onMessage = chrome.runtime.onMessage;
        const originalAdd = onMessage.addListener.bind(onMessage);

        onMessage.addListener = (listener) => {
          if (typeof listener === "function") {
            globalThis.__installedToolRuntimeMessageListeners.push(listener);
          }
          return originalAdd(listener);
        };
      },
    });

    this.injectedContentScripts.add(bridgeKey);
  },

  async sendRuntimeMessage(toolId, args = []) {
    const message = this.extractRuntimeMessage(args);
    if (message == null) {
      throw new Error("پیام ارسالی خالی است.");
    }

    const tab = await this.getTargetTab();
    const sender = { tab, id: toolId };

    if (typeof InstalledToolBackgroundHost !== "undefined") {
      const backgroundResult = await InstalledToolBackgroundHost.dispatch(toolId, message, sender);
      if (backgroundResult.handled) {
        return backgroundResult.response;
      }
    }

    return this.sendMessageToContentScript(toolId, message);
  },

  async sendTabMessage(toolId, tabId, message, options) {
    try {
      await this.injectToolBundle(toolId, tabId);
    } catch (error) {
      console.warn("Installed tool inject before send failed:", error);
    }

    try {
      if (options !== undefined) {
        return await chrome.tabs.sendMessage(tabId, message, options);
      }
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      return this.dispatchMessageViaInjection(tabId, message);
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

  async registerContentScripts(toolId, definitions = []) {
    const defs = Array.isArray(definitions) ? definitions : [definitions];
    const existing = this.registeredContentScripts.get(toolId) || [];
    this.registeredContentScripts.set(toolId, existing.concat(defs));

    const tab = await this.getTargetTab();
    const record = await this.getToolRecord(toolId);

    for (const def of defs) {
      const entry = this.normalizeContentScriptEntry({
        js: def.js,
        css: def.css,
        all_frames: def.allFrames ?? def.all_frames,
        world: def.world,
      });

      await this.ensureRuntimePrelude(tab.id, toolId, record, entry.world, entry.all_frames);

      for (const jsFile of entry.js) {
        const source = this.getToolFileText(record, jsFile);
        if (!source) continue;
        await this.injectScriptSource(tab.id, source, {
          allFrames: entry.all_frames,
          world: entry.world,
        });
      }

      for (const cssFile of entry.css) {
        const css = this.getToolFileText(record, cssFile);
        if (!css) continue;
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: entry.all_frames },
          css,
        });
      }
    }

    return defs;
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

      case "scripting.registerContentScripts":
        return this.registerContentScripts(toolId, args[0]);

      case "runtime.sendMessage":
        return this.sendRuntimeMessage(toolId, args);

      default:
        throw new Error(`Chrome API پشتیبانی نمی‌شود: ${path}`);
    }
  },

  clearInjectionCache(toolId = null) {
    if (!toolId) {
      this.injectedContentScripts.clear();
      this.registeredContentScripts.clear();
      this.pendingScriptFiles.clear();
      this.clearPreferredTabId();
      this.clearActiveToolId();
      if (typeof InstalledToolBackgroundHost !== "undefined") {
        InstalledToolBackgroundHost.unload();
      }
      return;
    }

    const prefix = `${toolId}:`;
    for (const key of [...this.injectedContentScripts]) {
      if (key.startsWith(prefix)) {
        this.injectedContentScripts.delete(key);
      }
    }

    if (this.activeToolId === toolId) {
      this.clearPreferredTabId();
      this.clearActiveToolId();
    }

    this.registeredContentScripts.delete(toolId);
    this.pendingScriptFiles.delete(toolId);

    if (typeof InstalledToolBackgroundHost !== "undefined") {
      InstalledToolBackgroundHost.unload(toolId);
    }
  },
};
