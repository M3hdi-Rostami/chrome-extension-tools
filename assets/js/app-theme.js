const THEME_STORAGE_KEY = "super-extension-theme";

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.documentElement.style.colorScheme = next;
  return next;
}

function setTheme(theme) {
  const next = applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore
  }
  document.dispatchEvent(new CustomEvent("app-theme-change", { detail: { theme: next } }));
  return next;
}

function toggleTheme() {
  return setTheme(getStoredTheme() === "dark" ? "light" : "dark");
}

function syncThemeToggleButton(button) {
  if (!button) return;
  const theme = getStoredTheme();
  button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  button.title = theme === "dark" ? "تم روشن" : "تم تاریک";
  button.setAttribute("aria-label", button.title);
  button.textContent = theme === "dark" ? "☀️" : "🌙";
}

function initThemeToggle(buttonId = "themeToggleBtn") {
  const button = document.getElementById(buttonId);
  if (!button) return;

  button.addEventListener("click", () => {
    toggleTheme();
    syncThemeToggleButton(button);
  });

  document.addEventListener("app-theme-change", () => syncThemeToggleButton(button));
  syncThemeToggleButton(button);
}

applyTheme(getStoredTheme());

window.AppTheme = {
  THEME_STORAGE_KEY,
  getStoredTheme,
  applyTheme,
  setTheme,
  toggleTheme,
  initThemeToggle,
};
