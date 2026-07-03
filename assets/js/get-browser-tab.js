function isInjectableBrowserTab(tab) {
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
}

async function getActiveBrowserTab() {
  try {
    const windows = await chrome.windows.getAll({
      populate: true,
      windowTypes: ["normal"],
    });

    const orderedWindows = [
      ...windows.filter((win) => win.focused),
      ...windows.filter((win) => !win.focused),
    ];

    for (const win of orderedWindows) {
      if (!win.tabs?.length) continue;

      const activeUsable = win.tabs.find((tab) => tab.active && isInjectableBrowserTab(tab));
      if (activeUsable) return activeUsable;

      const anyUsable = win.tabs.find((tab) => isInjectableBrowserTab(tab));
      if (anyUsable) return anyUsable;
    }
  } catch {
    // fall through
  }

  try {
    const currentWindowTabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const currentTab = currentWindowTabs.find(isInjectableBrowserTab);
    if (currentTab) return currentTab;
  } catch {
    // fall through
  }

  try {
    const activeTabs = await chrome.tabs.query({
      active: true,
      windowType: "normal",
    });
    const activeTab = activeTabs.find(isInjectableBrowserTab);
    if (activeTab) return activeTab;
  } catch {
    // fall through
  }

  try {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs.find(isInjectableBrowserTab) || null;
  } catch {
    return null;
  }
}

window.getActiveBrowserTab = getActiveBrowserTab;
window.isInjectableBrowserTab = isInjectableBrowserTab;
