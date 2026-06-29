async function getActiveBrowserTab() {
  try {
    const currentWindowTabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const currentTab = currentWindowTabs[0];
    if (currentTab?.id && !currentTab.url?.startsWith("chrome-extension://")) {
      return currentTab;
    }
  } catch {
    // fall through
  }

  try {
    const win = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    if (win?.tabs?.length) {
      return win.tabs.find((tab) => tab.active) || win.tabs[0];
    }
  } catch {
    // fall through
  }

  const tabs = await chrome.tabs.query({ active: true, windowType: "normal" });
  return tabs[0] || null;
}

window.getActiveBrowserTab = getActiveBrowserTab;
