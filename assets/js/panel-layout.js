(function () {
  const COMPACT_MAX = 399;
  const MEDIUM_MAX = 559;

  function updateBreakpoint(width) {
    const breakpoint =
      width <= COMPACT_MAX
        ? "compact"
        : width <= MEDIUM_MAX
          ? "medium"
          : "wide";

    document.body.dataset.panelBreakpoint = breakpoint;
  }

  function init() {
    const root = document.documentElement;
    updateBreakpoint(root.clientWidth);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateBreakpoint(entry.contentRect.width);
      }
    });

    observer.observe(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
