// Hearth Chat — per-page section back-navigation history.
// Include on pages that use section tabs (app.html, admin.html):
// <script src="nav.js" defer></script>

window.LC = window.LC || {};
LC.nav = (function () {
  "use strict";
  const STORAGE_PREFIX = "hearth-navstack:";
  const CONFIRM_WINDOW_MS = 2500;

  function storageKey() {
    return STORAGE_PREFIX + location.pathname;
  }

  let stack = [];
  let renderFn = null;
  let exitFn = null;
  let warnFn = null;
  let backArmed = false;
  let armTimer = null;

  function load() {
    try {
      const raw = sessionStorage.getItem(storageKey());
      stack = raw ? JSON.parse(raw) : [];
    } catch (e) { stack = []; }
  }

  function save() {
    try { sessionStorage.setItem(storageKey(), JSON.stringify(stack)); } catch (e) { /* ignore */ }
  }

  // Keep one "buffer" history entry pushed at all times so the next back
  // press fires our popstate handler instead of leaving the page.
  function armBuffer() {
    history.pushState({ hearthNav: true }, "", location.href);
  }

  function onPopState() {
    if (stack.length > 1) {
      stack.pop();
      save();
      backArmed = false;
      if (armTimer) clearTimeout(armTimer);
      if (renderFn) renderFn(stack[stack.length - 1]);
      armBuffer();
      return;
    }
    // Already showing the first section — one more back press logs out.
    if (backArmed) {
      clearTimeout(armTimer);
      backArmed = false;
      if (exitFn) exitFn();
      return;
    }
    backArmed = true;
    if (typeof warnFn === "function") warnFn("Press back again to log out");
    armBuffer();
    armTimer = setTimeout(() => { backArmed = false; }, CONFIRM_WINDOW_MS);
  }

  // opts: { root: string, render: fn(view), onExit: fn(), onWarn: fn(message) }
  function init(opts) {
    renderFn = opts.render;
    exitFn = opts.onExit;
    warnFn = opts.onWarn || null;
    load();
    if (!stack.length) stack = [opts.root];
    save();
    armBuffer();
    window.addEventListener("popstate", onPopState);
  }

  // Call when the user navigates to a section via a tab/nav click.
  function go(view) {
    if (stack[stack.length - 1] === view) return;
    stack.push(view);
    save();
  }

  // Wipe the saved section stack (call when logging out so a fresh login
  // starts back at the root section instead of an old session's stack).
  function clear() {
    stack = [];
    try { sessionStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
  }

  return { init, go, clear };
})();
