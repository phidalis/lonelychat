// Hearth Chat — PWA bootstrap
// - Registers the service worker and shows a small "update ready" banner.
// - Wires up every element with class "pwa-install-btn" on the page:
//     * Chrome/Edge/Android (support beforeinstallprompt): button triggers
//       the native install prompt.
//     * iOS Safari (no beforeinstallprompt): button opens a short
//       "Add to Home Screen" instructions modal instead.
//     * Already installed / running standalone: buttons stay hidden.
(function () {
  "use strict";

  function injectStyles() {
    if (document.getElementById("pwa-style")) return;
    const style = document.createElement("style");
    style.id = "pwa-style";
    style.textContent = `
      .pwa-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;
        background:#211f36;color:#fff;border-radius:14px;padding:14px 16px;
        display:flex;align-items:center;gap:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);
        font:500 14px/1.4 Inter,system-ui,sans-serif;max-width:420px;margin:0 auto;
        animation:pwa-slide-up .25s ease-out;}
      @keyframes pwa-slide-up{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
      .pwa-banner .pwa-icon{font-size:20px;flex-shrink:0}
      .pwa-banner .pwa-msg{flex:1;min-width:0}
      .pwa-banner button{border:none;border-radius:8px;padding:8px 12px;font:600 13px Inter,system-ui,sans-serif;
        cursor:pointer;white-space:nowrap}
      .pwa-banner .pwa-primary{background:#6c5ce7;color:#fff}
      .pwa-banner .pwa-dismiss{background:transparent;color:#c9c6e0;padding:8px}

      .pwa-modal-backdrop{position:fixed;inset:0;z-index:9998;background:rgba(10,14,30,.55);
        display:flex;align-items:center;justify-content:center;padding:20px;
        animation:pwa-fade-in .15s ease-out;}
      @keyframes pwa-fade-in{from{opacity:0}to{opacity:1}}
      .pwa-modal{background:#fff;border-radius:18px;padding:26px 24px 22px;max-width:340px;width:100%;
        text-align:center;font:500 14px/1.5 Inter,system-ui,sans-serif;color:#211f36;
        box-shadow:0 20px 60px rgba(0,0,0,.3);}
      .pwa-modal .pwa-modal-icon{font-size:32px;margin-bottom:8px}
      .pwa-modal h3{margin:0 0 6px;font-size:17px}
      .pwa-modal p.pwa-modal-sub{margin:0 0 18px;color:#726f8a;font-size:13.5px}
      .pwa-modal .pwa-modal-steps{text-align:left;margin:0 0 18px;padding:0;list-style:none}
      .pwa-modal .pwa-modal-steps li{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;font-size:13.5px}
      .pwa-modal .pwa-modal-steps .n{flex-shrink:0;width:22px;height:22px;border-radius:999px;background:#6c5ce7;
        color:#fff;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center}
      .pwa-modal .pwa-modal-close{border:none;border-radius:10px;padding:11px 16px;font:600 14px Inter,system-ui,sans-serif;
        cursor:pointer;background:#6c5ce7;color:#fff;width:100%}
    `;
    document.head.appendChild(style);
  }

  // ---- Update-available banner (bottom of screen) ----
  function showBanner({ icon, message, primaryLabel, onPrimary, onDismiss }) {
    injectStyles();
    const existing = document.querySelector(".pwa-banner");
    if (existing) existing.remove();
    const bar = document.createElement("div");
    bar.className = "pwa-banner";
    bar.innerHTML = `
      <span class="pwa-icon">${icon}</span>
      <span class="pwa-msg">${message}</span>
      <button class="pwa-primary" type="button">${primaryLabel}</button>
      <button class="pwa-dismiss" type="button" aria-label="Dismiss">&times;</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector(".pwa-primary").addEventListener("click", () => {
      onPrimary();
      bar.remove();
    });
    bar.querySelector(".pwa-dismiss").addEventListener("click", () => {
      if (onDismiss) onDismiss();
      bar.remove();
    });
    return bar;
  }

  // ---- iOS "Add to Home Screen" instructions modal ----
  function showIOSInstallModal() {
    injectStyles();
    const existing = document.querySelector(".pwa-modal-backdrop");
    if (existing) existing.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "pwa-modal-backdrop";
    backdrop.innerHTML = `
      <div class="pwa-modal" role="dialog" aria-modal="true" aria-label="Install Hearth Chat">
        <div class="pwa-modal-icon">💜</div>
        <h3>Install Hearth Chat</h3>
        <p class="pwa-modal-sub">Add Hearth Chat to your Home Screen for a faster, full-screen experience.</p>
        <ol class="pwa-modal-steps">
          <li><span class="n">1</span><span>Tap the <b>Share</b> icon in Safari's toolbar.</span></li>
          <li><span class="n">2</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
          <li><span class="n">3</span><span>Tap <b>Add</b> in the top-right corner to confirm.</span></li>
        </ol>
        <button class="pwa-modal-close" type="button">Got it</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector(".pwa-modal-close").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  }

  // ---- Generic "how to install" modal (desktop / browsers without a native prompt) ----
  function showGenericInstallModal() {
    injectStyles();
    const existing = document.querySelector(".pwa-modal-backdrop");
    if (existing) existing.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "pwa-modal-backdrop";

    if (!window.isSecureContext) {
      // The page is served over HTTP — browsers refuse to install in this
      // case, so explain it instead of showing install instructions.
      backdrop.innerHTML = `
        <div class="pwa-modal" role="dialog" aria-modal="true" aria-label="Install Hearth Chat">
          <div class="pwa-modal-icon">🔒</div>
          <h3>Installation needs HTTPS</h3>
          <p class="pwa-modal-sub">This page is being served over an insecure connection, so the browser blocks app installation.</p>
          <ol class="pwa-modal-steps">
            <li><span class="n">1</span><span>Make sure you open the site as <b>https://lovelinkus.site</b> (with the padlock).</span></li>
            <li><span class="n">2</span><span>On GitHub Pages, wait for the domain's SSL certificate to be issued, then turn on <b>Enforce HTTPS</b>.</span></li>
            <li><span class="n">3</span><span>Hard refresh (Ctrl+Shift+R) and try <b>Install App</b> again.</span></li>
          </ol>
          <button class="pwa-modal-close" type="button">Got it</button>
        </div>
      `;
    } else {
      backdrop.innerHTML = `
        <div class="pwa-modal" role="dialog" aria-modal="true" aria-label="Install Hearth Chat">
          <div class="pwa-modal-icon">💜</div>
          <h3>Install Hearth Chat</h3>
          <p class="pwa-modal-sub">Add Hearth Chat as an app for a faster, full-screen experience.</p>
          <ol class="pwa-modal-steps">
            <li><span class="n">1</span><span>Look for an <b>install icon</b> (⊕ or a small monitor/arrow) at the right side of your address bar.</span></li>
            <li><span class="n">2</span><span>Or open your browser's <b>menu (⋮ / ···)</b> and choose <b>Install Hearth Chat</b> / <b>Add to Home Screen</b>.</span></li>
          </ol>
          <p class="pwa-modal-sub" style="margin:-8px 0 18px">Works best in Chrome, Edge, or Safari on iPhone.</p>
          <button class="pwa-modal-close" type="button">Got it</button>
        </div>
      `;
    }

    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector(".pwa-modal-close").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  }

  // ---- Service worker registration + update flow ----
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              showBanner({
                icon: "💜",
                message: "A new version of Hearth Chat is ready.",
                primaryLabel: "Refresh",
                onPrimary: () => {
                  installing.postMessage("SKIP_WAITING");
                }
              });
            }
          });
        });
      }).catch((err) => console.warn("[pwa] service worker registration failed", err));

      let refreshed = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshed) return;
        refreshed = true;
        window.location.reload();
      });
    });
  }

  // ---- Install buttons (header/nav buttons with class "pwa-install-btn") ----
  function installButtons() {
    return Array.prototype.slice.call(document.querySelectorAll(".pwa-install-btn"));
  }

  function showInstallButtons() {
    installButtons().forEach((btn) => btn.classList.remove("hidden"));
  }

  function hideInstallButtons() {
    installButtons().forEach((btn) => btn.classList.add("hidden"));
  }

  function bindInstallButtons(handler) {
    installButtons().forEach((btn) => {
      if (btn.dataset.pwaBound) return;
      btn.dataset.pwaBound = "1";
      btn.addEventListener("click", handler);
    });
  }

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  const ua = navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua) && !window.MSStream;

  // Prefer the prompt captured by the early inline <head> script: pwa.js is
  // deferred, and beforeinstallprompt can fire before deferred scripts run,
  // so capturing it in <head> guarantees we never miss the event.
  let deferredInstallPrompt = window.__pwaInstallPrompt || null;
  let promptDismissed = false;

  function triggerPrompt() {
    if (!deferredInstallPrompt) return;
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    window.__pwaInstallPrompt = null;
    try {
      promptEvent.prompt();
      promptEvent.userChoice
        .then((choice) => {
          if (choice && choice.outcome === "dismissed") promptDismissed = true;
        })
        .catch(() => {});
    } catch (err) {
      // prompt() can throw when it is not allowed in this context (e.g. no
      // active user gesture). Fall back to the instructions modal.
      showGenericInstallModal();
    }
  }

  // Called when the user clicks Install before beforeinstallprompt has fired.
  // Chrome/Edge usually fire beforeinstallprompt only after the first user
  // engagement — often right after this very click. Wait briefly for that
  // event so the native install dialog actually appears; only if it never
  // arrives do we fall back to the "how to install" instructions modal.
  function prepareThenTrigger(btn) {
    const PREPARE_WAIT_MS = 4000;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing&hellip;';
    let settled = false;

    const finish = (fallback) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("beforeinstallprompt", onPrompt);
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      if (fallback) showGenericInstallModal();
    };

    const onPrompt = () => {
      if (deferredInstallPrompt) {
        triggerPrompt();
        finish(false);
      }
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.setTimeout(() => finish(true), PREPARE_WAIT_MS);
  }

  if (isStandalone) {
    // Already installed / running as the app — nothing to show.
    hideInstallButtons();
  } else {
    // Show the button right away rather than waiting on beforeinstallprompt,
    // which is unreliable (Chrome delays it behind engagement heuristics).
    showInstallButtons();
    bindInstallButtons((evt) => {
      if (deferredInstallPrompt) {
        triggerPrompt();
      } else if (isIOS) {
        showIOSInstallModal();
      } else if (promptDismissed) {
        // Chrome won't re-fire beforeinstallprompt after the user dismissed
        // it this session — go straight to the instructions modal.
        showGenericInstallModal();
      } else {
        prepareThenTrigger(evt.currentTarget);
      }
    });

    // Capture the native prompt so the button uses it instead of the generic
    // instructions. This mirrors the early <head> listener for safety.
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      window.__pwaInstallPrompt = e;
    });
  }

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    window.__pwaInstallPrompt = null;
    hideInstallButtons();
    const modal = document.querySelector(".pwa-modal-backdrop");
    if (modal) modal.remove();
  });
})();
