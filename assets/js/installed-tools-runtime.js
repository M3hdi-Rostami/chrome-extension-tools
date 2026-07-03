const InstalledToolsRuntime = {
  slugify(value) {
    return String(value || "tool")
      .toLowerCase()
      .replace(/\.zip$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tool";
  },

  normalizeToolId(rawId, fallbackName) {
    const base = String(rawId || fallbackName || "tool")
      .trim()
      .replace(/^tool-custom-/, "")
      .replace(/^tool-/, "");
    return `tool-custom-${this.slugify(base)}`;
  },

  collectZipFiles(zip) {
    const files = new Map();

    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
      files.set(path, entry);
    });

    return this.normalizeZipRoot(files);
  },

  normalizeZipRoot(filesMap) {
    const paths = [...filesMap.keys()];
    if (paths.length === 0) return filesMap;

    const rootCandidates = ["popup.html", "index.html", "tool.json", "manifest.json"];
    if (rootCandidates.some((name) => filesMap.has(name))) {
      return filesMap;
    }

    const firstSegments = [...new Set(paths.map((path) => path.split("/")[0]))];
    if (firstSegments.length !== 1) return filesMap;

    const root = firstSegments[0];
    if (!paths.every((path) => path.startsWith(`${root}/`))) return filesMap;

    const normalized = new Map();
    for (const [path, entry] of filesMap.entries()) {
      normalized.set(path.slice(root.length + 1), entry);
    }

    return normalized;
  },

  findEntryPath(files, manifest) {
    if (manifest?.entry && files.has(manifest.entry)) {
      return manifest.entry;
    }

    const preferred = [
      "popup.html",
      "index.html",
      "templates/index.html",
    ];

    for (const path of preferred) {
      if (files.has(path)) return path;
    }

    const suffixes = ["/popup.html", "/index.html", "popup.html", "index.html"];
    for (const path of files.keys()) {
      if (suffixes.some((suffix) => path === suffix || path.endsWith(suffix))) {
        return path;
      }
    }

    return null;
  },

  dirname(filePath) {
    const index = filePath.lastIndexOf("/");
    return index === -1 ? "" : filePath.slice(0, index);
  },

  resolveRelativePath(baseDir, target) {
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("data:")) {
      return null;
    }

    const stack = [...baseDir.split("/").filter(Boolean)];
    const parts = target.split("/");

    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }

    return stack.join("/");
  },

  async filesMapToTextMap(filesMap) {
    const textMap = new Map();
    for (const [path, entry] of filesMap.entries()) {
      textMap.set(path, await entry.async("string"));
    }
    return textMap;
  },

  async filesMapToBase64Map(filesMap) {
    const base64Map = {};
    for (const [path, entry] of filesMap.entries()) {
      base64Map[path] = await entry.async("base64");
    }
    return base64Map;
  },

  extractTemplateBody(html) {
    const match = html.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
    return match ? match[1].trim() : null;
  },

  wrapHtmlDocument(bodyHtml, extraHead = "") {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${extraHead}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: Tahoma, sans-serif; background: #111621; color: #fff; }
    body { min-height: 100%; box-sizing: border-box; }
    *, *::before, *::after { box-sizing: border-box; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
  },

  decodeBase64Utf8(base64) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  },

  getMimeType(filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const map = {
      html: "text/html;charset=utf-8",
      htm: "text/html;charset=utf-8",
      js: "text/javascript;charset=utf-8",
      mjs: "text/javascript;charset=utf-8",
      css: "text/css;charset=utf-8",
      json: "application/json;charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      woff: "font/woff",
      woff2: "font/woff2",
    };
    return map[ext] || "application/octet-stream";
  },

  getChromeCompatibilityShim(toolId, pathUrlMap = {}) {
    const storagePrefix = `installed-tool:${toolId}:`;
    const pathMapJson = JSON.stringify(pathUrlMap);
    return `(function () {
  if (window.__installedToolChromeShim) return;
  window.__installedToolChromeShim = true;
  var prefix = ${JSON.stringify(storagePrefix)};
  var pathMap = ${pathMapJson};

  function normalizePath(path) {
    return String(path || "").replace(/^\\//, "");
  }

  function resolveToolAsset(path) {
    var normalized = normalizePath(path);
    if (pathMap[normalized]) return pathMap[normalized];
    if (pathMap[path]) return pathMap[path];
    return path;
  }

  function headersToObject(headers) {
    if (!headers) return undefined;
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      var obj = {};
      headers.forEach(function (value, key) { obj[key] = value; });
      return obj;
    }
    return headers;
  }

  function serializeFetchBody(body) {
    if (body == null) return Promise.resolve(undefined);
    if (typeof body === "string") return Promise.resolve(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Promise.resolve(body.toString());
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return body.text();
    }
    if (body instanceof ArrayBuffer) {
      return Promise.resolve(new TextDecoder().decode(body));
    }
    return Promise.resolve(String(body));
  }

  var nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  function proxyFetch(input, init) {
    var url = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
    if (!/^https?:/i.test(url)) {
      if (nativeFetch) return nativeFetch(input, init);
      return Promise.reject(new TypeError("Failed to fetch"));
    }

    var options = init || {};
    if (typeof Request !== "undefined" && input instanceof Request) {
      options = {
        method: input.method,
        headers: headersToObject(input.headers),
        body: input.body,
        credentials: input.credentials,
        mode: input.mode,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
      };
    }

    return serializeFetchBody(options.body).then(function (serializedBody) {
      return new Promise(function (resolve, reject) {
        var requestId = "fetch_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        var timeoutId = setTimeout(function () {
          window.removeEventListener("message", onResponse);
          reject(new TypeError("Failed to fetch"));
        }, 120000);

        function onResponse(event) {
          if (!event.data || event.data.type !== "installed-tool-fetch-response") return;
          if (event.data.id !== requestId) return;
          clearTimeout(timeoutId);
          window.removeEventListener("message", onResponse);

          if (event.data.error) {
            reject(new TypeError(event.data.error));
            return;
          }

          resolve(new Response(event.data.body, {
            status: event.data.status || 200,
            statusText: event.data.statusText || "OK",
            headers: event.data.headers || {},
          }));
        }

        window.addEventListener("message", onResponse);
        var parentWindow = window.parent && window.parent !== window ? window.parent : window;
        parentWindow.postMessage({
          type: "installed-tool-fetch",
          id: requestId,
          url: url,
          options: {
            method: options.method || "GET",
            headers: headersToObject(options.headers),
            body: serializedBody,
            credentials: options.credentials || "include",
            mode: options.mode || "cors",
          },
        }, "*");
      });
    });
  }

  window.fetch = proxyFetch;

  function normalizeKeys(keys) {
    if (keys == null) return { list: null, defaults: null };
    if (typeof keys === "string") return { list: [keys], defaults: null };
    if (Array.isArray(keys)) return { list: keys, defaults: null };
    return { list: Object.keys(keys), defaults: keys };
  }

  function createStorageArea() {
    return {
      get: function (keys, callback) {
        var cb = typeof keys === "function" ? keys : callback;
        var normalized = normalizeKeys(typeof keys === "function" ? null : keys);
        var result = {};
        try {
          if (normalized.list) {
            normalized.list.forEach(function (key) {
              var raw = localStorage.getItem(prefix + key);
              if (raw !== null) result[key] = JSON.parse(raw);
            });
          } else {
            for (var i = 0; i < localStorage.length; i++) {
              var storageKey = localStorage.key(i);
              if (storageKey && storageKey.indexOf(prefix) === 0) {
                var itemKey = storageKey.slice(prefix.length);
                result[itemKey] = JSON.parse(localStorage.getItem(storageKey));
              }
            }
          }
          if (normalized.defaults) {
            Object.keys(normalized.defaults).forEach(function (key) {
              if (result[key] === undefined) result[key] = normalized.defaults[key];
            });
          }
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = null;
        } catch (error) {
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = { message: String(error) };
        }
        if (typeof cb === "function") cb(result);
        return Promise.resolve(result);
      },
      set: function (items, callback) {
        try {
          Object.keys(items || {}).forEach(function (key) {
            localStorage.setItem(prefix + key, JSON.stringify(items[key]));
          });
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = null;
        } catch (error) {
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = { message: String(error) };
        }
        if (typeof callback === "function") callback();
        return Promise.resolve();
      },
      remove: function (keys, callback) {
        var keyList = typeof keys === "string" ? [keys] : keys || [];
        try {
          keyList.forEach(function (key) {
            localStorage.removeItem(prefix + key);
          });
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = null;
        } catch (error) {
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = { message: String(error) };
        }
        if (typeof callback === "function") callback();
        return Promise.resolve();
      },
      clear: function (callback) {
        try {
          var toRemove = [];
          for (var i = 0; i < localStorage.length; i++) {
            var storageKey = localStorage.key(i);
            if (storageKey && storageKey.indexOf(prefix) === 0) toRemove.push(storageKey);
          }
          toRemove.forEach(function (key) { localStorage.removeItem(key); });
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = null;
        } catch (error) {
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = { message: String(error) };
        }
        if (typeof callback === "function") callback();
        return Promise.resolve();
      },
    };
  }

  var localArea = createStorageArea();
  window.chrome = window.chrome || {};
  window.chrome.storage = window.chrome.storage || { local: localArea, sync: localArea };
  window.chrome.runtime = window.chrome.runtime || {
    id: "installed-tool",
    lastError: null,
    getURL: function (path) { return resolveToolAsset(path); },
  };
  if (!window.chrome.runtime.getURL) {
    window.chrome.runtime.getURL = function (path) { return resolveToolAsset(path); };
  }

  var toolId = ${JSON.stringify(toolId)};

  function proxyChromeApi(path, args) {
    var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;

    return new Promise(function (resolve, reject) {
      var requestId = "chrome_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var timeoutId = setTimeout(function () {
        window.removeEventListener("message", onResponse);
        reject(new Error("Chrome API request timed out"));
      }, 120000);

      function onResponse(event) {
        if (!event.data || event.data.type !== "installed-tool-chrome-api-response") return;
        if (event.data.id !== requestId) return;
        clearTimeout(timeoutId);
        window.removeEventListener("message", onResponse);

        if (event.data.error) {
          if (window.chrome && chrome.runtime) chrome.runtime.lastError = { message: event.data.error };
          reject(new Error(event.data.error));
          return;
        }

        if (window.chrome && chrome.runtime) chrome.runtime.lastError = null;
        resolve(event.data.result);
      }

      window.addEventListener("message", onResponse);
      var parentWindow = window.parent && window.parent !== window ? window.parent : window;
      parentWindow.postMessage({
        type: "installed-tool-chrome-api",
        id: requestId,
        toolId: toolId,
        path: path,
        args: args,
      }, "*");
    }).then(function (result) {
      if (typeof callback === "function") callback(result);
      return result;
    }, function (error) {
      if (typeof callback === "function") callback(undefined);
      throw error;
    });
  }

  function serializeExecuteScriptArg(injection) {
    if (!injection || typeof injection !== "object") return injection;
    var copy = Object.assign({}, injection);
    if (typeof injection.func === "function") {
      copy.funcSource = injection.func.toString();
      delete copy.func;
    }
    return copy;
  }

  window.chrome.tabs = {
    query: function (queryInfo, callback) {
      return proxyChromeApi("tabs.query", [queryInfo]).then(function (result) {
        if (typeof callback === "function") callback(result);
        return result;
      });
    },
    get: function (tabId, callback) {
      return proxyChromeApi("tabs.get", [tabId]).then(function (result) {
        if (typeof callback === "function") callback(result);
        return result;
      });
    },
    create: function (createProperties, callback) {
      return proxyChromeApi("tabs.create", [createProperties]).then(function (result) {
        if (typeof callback === "function") callback(result);
        return result;
      });
    },
    sendMessage: function (tabId, message, options, callback) {
      var args = [tabId, message];
      if (typeof options === "function") {
        callback = options;
      } else if (options !== undefined) {
        args.push(options);
      }
      return proxyChromeApi("tabs.sendMessage", args).then(function (result) {
        if (typeof callback === "function") callback(result);
        return result;
      });
    },
  };

  window.chrome.scripting = {
    executeScript: function (injection) {
      return proxyChromeApi("scripting.executeScript", [serializeExecuteScriptArg(injection)]);
    },
    insertCSS: function (injection) {
      return proxyChromeApi("scripting.insertCSS", [injection]);
    },
  };

  window.chrome.tabs.executeScript = function () {
    var args = Array.prototype.slice.call(arguments);
    var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    return proxyChromeApi("tabs.executeScript", args).then(function (result) {
      if (typeof callback === "function") callback(result);
      return result;
    });
  };

  window.chrome.runtime.sendMessage = function () {
    var args = Array.prototype.slice.call(arguments);
    var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    return proxyChromeApi("runtime.sendMessage", args).then(function (result) {
      if (typeof callback === "function") callback(result);
      return result;
    });
  };
  window.chrome.downloads = window.chrome.downloads || {
    download: function (options, callback) {
      try {
        var anchor = document.createElement("a");
        anchor.href = options && options.url ? options.url : "#";
        anchor.download = options && options.filename ? options.filename : "";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        if (typeof callback === "function") callback(1);
        return Promise.resolve(1);
      } catch (error) {
        if (typeof callback === "function") callback();
        return Promise.resolve();
      }
    },
  };
})();`;
  },

  injectRuntimeCsp(html) {
    const csp =
      '<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: \'unsafe-inline\' \'unsafe-eval\'; script-src * data: blob: \'unsafe-inline\' \'unsafe-eval\'; style-src * data: blob: \'unsafe-inline\'; img-src * data: blob:; font-src * data: blob:; connect-src * data: blob:;">';
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
    }
    if (/<html[\s>]/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`);
    }
    return `${csp}${html}`;
  },

  injectChromeShim(html, toolId, pathUrlMap = {}) {
    const shimScript = `<script>\n${this.getChromeCompatibilityShim(toolId, pathUrlMap)}\n</script>`;
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${shimScript}`);
    }
    if (/<html[\s>]/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${shimScript}</head>`);
    }
    return `${shimScript}${html}`;
  },

  inlineStylesheets(html, baseDir, textMap, urlMap = null) {
    return html.replace(/<link\b[^>]*>/gi, (tag) => {
      const relMatch = tag.match(/\brel=["']([^"']+)["']/i);
      if (relMatch && !/stylesheet/i.test(relMatch[1])) return tag;

      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!hrefMatch) return tag;

      const resolved = this.resolveRelativePath(baseDir, hrefMatch[1]);
      if (!resolved || !textMap.has(resolved)) return tag;

      let css = textMap.get(resolved);
      if (urlMap) {
        css = this.rewriteCssUrls(css, resolved, urlMap);
      }

      return `<style>/* ${resolved} */\n${css}</style>`;
    });
  },

  rewriteCssUrls(css, cssFilePath, urlMap) {
    const baseDir = this.dirname(cssFilePath);
    return css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote, target) => {
      const trimmed = target.trim();
      if (/^(https?:|data:|blob:|#)/i.test(trimmed)) return match;
      const resolved = this.resolveRelativePath(baseDir, trimmed);
      if (resolved && urlMap.has(resolved)) {
        return `url(${quote}${urlMap.get(resolved)}${quote})`;
      }
      return match;
    });
  },

  inlineScripts(html, baseDir, textMap) {
    let output = html;
    let previous;

    do {
      previous = output;
      output = output.replace(
        /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
        (fullMatch, beforeSrc, src, afterSrc) => {
          const resolved = this.resolveRelativePath(baseDir, src);
          if (!resolved || !textMap.has(resolved)) return fullMatch;
          const attrs = `${beforeSrc || ""}${afterSrc || ""}`
            .replace(/\bsrc=["'][^"']+["']/gi, "")
            .replace(/\basync\b/gi, "")
            .replace(/\bdefer\b/gi, "")
            .replace(/\btype=["']module["']/gi, "")
            .trim();
          const attrString = attrs ? ` ${attrs}` : "";
          return `<script${attrString}>\n${textMap.get(resolved)}\n</script>`;
        },
      );
    } while (output !== previous);

    return output;
  },

  appendScript(html, scriptContent) {
    if (!scriptContent?.trim()) return html;
    if (html.includes("</body>")) {
      return html.replace("</body>", `<script>\n${scriptContent}\n</script></body>`);
    }
    return `${html}\n<script>\n${scriptContent}\n</script>`;
  },

  relocateHeadScriptsToBody(html) {
    const headScripts = [];

    const withHeadCleaned = html.replace(/<head([^>]*)>([\s\S]*?)<\/head>/i, (full, headAttrs, headInner) => {
      const cleanedInner = headInner.replace(/<script\b[\s\S]*?<\/script>/gi, (scriptTag) => {
        headScripts.push(scriptTag);
        return "";
      });
      return `<head${headAttrs}>${cleanedInner}</head>`;
    });

    if (headScripts.length === 0) return html;
    if (withHeadCleaned.includes("</body>")) {
      return withHeadCleaned.replace("</body>", `${headScripts.join("\n")}\n</body>`);
    }
    return `${withHeadCleaned}\n${headScripts.join("\n")}`;
  },

  rewriteNonScriptAssetUrls(html, baseDir, urlMap) {
    return html.replace(/(\s(?:src|href)=["'])([^"']+)(["'])/gi, (match, prefix, target, suffix) => {
      if (/^(https?:|data:|blob:|#|javascript:)/i.test(target)) return match;
      if (/\.m?js$/i.test(target.split("?")[0])) return match;
      const resolved = this.resolveRelativePath(baseDir, target);
      if (resolved && urlMap.has(resolved)) {
        return `${prefix}${urlMap.get(resolved)}${suffix}`;
      }
      return match;
    });
  },

  rewriteAssetUrls(html, baseDir, urlMap) {
    return html.replace(/(\s(?:src|href)=["'])([^"']+)(["'])/gi, (match, prefix, target, suffix) => {
      if (/^(https?:|data:|blob:|#|javascript:)/i.test(target)) return match;
      const resolved = this.resolveRelativePath(baseDir, target);
      if (resolved && urlMap.has(resolved)) {
        return `${prefix}${urlMap.get(resolved)}${suffix}`;
      }
      return match;
    });
  },

  buildTextMapFromBase64(files) {
    const textMap = new Map();
    for (const [path, base64] of Object.entries(files || {})) {
      if (/\.(html?|js|mjs|css|json|svg|txt|md)$/i.test(path)) {
        textMap.set(path, this.decodeBase64Utf8(base64));
      }
    }
    return textMap;
  },

  createDataUrlMap(files) {
    const urlMap = new Map();

    for (const [path, base64] of Object.entries(files || {})) {
      urlMap.set(path, `data:${this.getMimeType(path)};base64,${base64}`);
    }

    return urlMap;
  },

  createBlobUrlMapForAssets(files) {
    const urlMap = new Map();
    const revokeList = [];

    for (const [path, base64] of Object.entries(files || {})) {
      if (/\.(html?|js|mjs|css|json|txt|md)$/i.test(path)) continue;

      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: this.getMimeType(path) }));
      urlMap.set(path, url);
      revokeList.push(url);
    }

    return { urlMap, revokeList };
  },

  createBlobUrlMap(files) {
    const urlMap = new Map();
    const revokeList = [];

    for (const [path, base64] of Object.entries(files || {})) {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: this.getMimeType(path) }));
      urlMap.set(path, url);
      revokeList.push(url);
    }

    return { urlMap, revokeList };
  },

  prepareLaunchHtml(record) {
    const entryPath = record.manifest?.entry;
    const files = record.files || {};
    const textMap = this.buildTextMapFromBase64(files);

    if (!entryPath || !textMap.has(entryPath)) {
      return {
        html: record.bundledHtml || "",
        revoke: () => {},
      };
    }

    const urlMap = this.createDataUrlMap(files);
    const pathUrlMap = Object.fromEntries(urlMap.entries());
    const baseDir = this.dirname(entryPath);
    let html = textMap.get(entryPath);
    const templateBody = this.extractTemplateBody(html);

    if (templateBody) {
      const wrapperId = record.manifest.containerId || record.id;
      html = this.wrapHtmlDocument(`<div id="${wrapperId}">${templateBody}</div>`);
    } else if (!/<html[\s>]/i.test(html)) {
      html = this.wrapHtmlDocument(html);
    }

    html = this.relocateHeadScriptsToBody(html);
    html = this.inlineStylesheets(html, baseDir, textMap, urlMap);
    html = this.inlineScripts(html, baseDir, textMap);
    html = this.rewriteNonScriptAssetUrls(html, baseDir, urlMap);
    html = this.injectRuntimeCsp(html);
    html = this.injectChromeShim(html, record.id, pathUrlMap);

    if (record.manifest.script && textMap.has(record.manifest.script)) {
      const scriptContent = textMap.get(record.manifest.script);
      if (!html.includes(scriptContent.slice(0, Math.min(120, scriptContent.length)))) {
        html = this.appendScript(html, scriptContent);
      }
    }

    if (record.manifest.initFunction) {
      html = this.appendScript(
        html,
        `document.addEventListener("DOMContentLoaded", function () {
  if (typeof ${record.manifest.initFunction} === "function") {
    ${record.manifest.initFunction}();
  }
});`,
      );
    }

    return {
      html,
      revoke: () => {},
    };
  },

  async bundleToolHtml(filesMap, manifest) {
    const entryPath = manifest.entry;
    const textMap = await this.filesMapToTextMap(filesMap);
    const entryHtml = textMap.get(entryPath);
    if (!entryHtml) {
      throw new Error("فایل ورودی ابزار یافت نشد.");
    }

    const baseDir = this.dirname(entryPath);
    let html = entryHtml;
    const templateBody = this.extractTemplateBody(entryHtml);

    if (templateBody) {
      const wrapperId = manifest.containerId || manifest.id;
      html = this.wrapHtmlDocument(`<div id="${wrapperId}">${templateBody}</div>`);
    } else if (!/<html[\s>]/i.test(entryHtml)) {
      html = this.wrapHtmlDocument(entryHtml);
    }

    html = this.inlineStylesheets(html, baseDir, textMap);
    html = this.inlineScripts(html, baseDir, textMap);
    html = this.injectRuntimeCsp(html);
    html = this.injectChromeShim(html, manifest.id);

    if (manifest.script && textMap.has(manifest.script)) {
      html = this.appendScript(html, textMap.get(manifest.script));
    }

    if (manifest.initFunction) {
      html = this.appendScript(
        html,
        `document.addEventListener("DOMContentLoaded", function () {
  if (typeof ${manifest.initFunction} === "function") {
    ${manifest.initFunction}();
  }
});`,
      );
    }

    return html;
  },

  async parseManifest(filesMap) {
    if (!filesMap.has("tool.json")) return null;

    try {
      const raw = await filesMap.get("tool.json").async("string");
      return JSON.parse(raw);
    } catch {
      throw new Error("فایل tool.json نامعتبر است.");
    }
  },

  async parseChromeManifest(filesMap) {
    if (!filesMap.has("manifest.json")) return null;

    try {
      const raw = await filesMap.get("manifest.json").async("string");
      const json = JSON.parse(raw);

      if (!json || typeof json !== "object" || json.manifest_version == null) {
        return null;
      }

      const entry =
        json.action?.default_popup ||
        json.browser_action?.default_popup ||
        json.side_panel?.default_path ||
        (filesMap.has("popup.html") ? "popup.html" : null);

      return {
        id: json.name || json.short_name || null,
        title: json.name || json.short_name || null,
        description: json.description || "ابزار نصب‌شده",
        icon: "🧩",
        entry,
        packageType: "chrome-extension",
        contentScripts: Array.isArray(json.content_scripts) ? json.content_scripts : [],
      };
    } catch {
      return null;
    }
  },

  mergeRawManifest(toolManifest, chromeManifest, fileName) {
    const fallbackTitle = fileName.replace(/\.zip$/i, "") || "ابزار جدید";

    if (toolManifest) {
      return {
        ...toolManifest,
        packageType: toolManifest.packageType || "tool-json",
      };
    }

    if (chromeManifest) {
      return {
        ...chromeManifest,
        packageType: "chrome-extension",
      };
    }

    return {
      title: fallbackTitle,
      description: "ابزار نصب‌شده",
      icon: "📦",
      packageType: "html-only",
    };
  },

  async parseZip(file) {
    if (typeof JSZip === "undefined") {
      throw new Error("کتابخانه JSZip در دسترس نیست.");
    }

    const zip = await JSZip.loadAsync(file);
    const filesMap = this.collectZipFiles(zip);

    if (filesMap.size === 0) {
      throw new Error("فایل ZIP خالی است.");
    }

    const rawToolManifest = await this.parseManifest(filesMap);
    const rawChromeManifest = await this.parseChromeManifest(filesMap);
    const rawManifest = this.mergeRawManifest(rawToolManifest, rawChromeManifest, file.name);
    const entryPath = this.findEntryPath(filesMap, rawManifest);

    if (!entryPath) {
      throw new Error(
        "فایل ورودی یافت نشد. ZIP باید popup.html یا index.html داشته باشد.",
      );
    }

    const manifest = {
      id: this.normalizeToolId(rawManifest?.id, rawManifest?.title || file.name),
      title: String(rawManifest?.title || file.name.replace(/\.zip$/i, "")).trim(),
      description: String(rawManifest?.description || "ابزار نصب‌شده").trim(),
      icon: rawManifest?.icon || "📦",
      entry: entryPath,
      script:
        rawManifest?.script ||
        (rawManifest.packageType !== "chrome-extension" && filesMap.has("js/index.js")
          ? "js/index.js"
          : null),
      initFunction: rawManifest?.initFunction || null,
      containerId: rawManifest?.containerId || null,
      packageType: rawManifest.packageType || "html-only",
      contentScripts: rawManifest?.contentScripts || [],
    };

    const bundledHtml = await this.bundleToolHtml(filesMap, manifest);
    const files = await this.filesMapToBase64Map(filesMap);

    return {
      id: manifest.id,
      title: manifest.title,
      description: manifest.description,
      icon: manifest.icon,
      installedAt: new Date().toISOString(),
      manifest,
      bundledHtml,
      files,
    };
  },
};
