// "Install app" prompt - makes the installability built into manifest.webmanifest
// / sw.js actually discoverable, instead of relying on a visitor noticing the
// browser's own small, easy-to-miss install icon.
//
// Two paths, since only one of them gets a real browser-driven prompt:
//   - Chrome/Edge/Android: the browser fires `beforeinstallprompt`. We stash
//     it and show our own banner with an "Install" button that replays it.
//   - iOS Safari: never fires that event at all (no API for it) - the only
//     way to install there is the manual Share -> Add to Home Screen flow,
//     so the banner shows those instructions as plain text instead of a
//     button.
// Both cases: skipped entirely if already running installed
// (display-mode: standalone), and deferred until AFTER the cookie-consent
// choice is made so the two banners never stack on a first visit.
(function () {
  var DISMISS_KEY = 'sitestock_pwa_install_dismissed';
  var COOKIE_KEY = 'sitestock_cookie_choice';
  var doc = document;
  var deferredPrompt = null;
  var banner = null;

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  function setDismissed() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* private mode - ignore */ }
  }
  function cookieChoiceMade() {
    try { return !!localStorage.getItem(COOKIE_KEY); } catch (e) { return true; } // fail open, don't block forever
  }
  function isStandalone() {
    return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true; // iOS's own non-standard flag
  }
  function isIosSafari() {
    var ua = window.navigator.userAgent;
    var isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIos && isSafari;
  }

  function removeBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function showBanner(kind) {
    if (banner || isStandalone() || dismissed()) return;
    banner = doc.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Install SiteStock');
    if (kind === 'prompt') {
      banner.innerHTML =
        '<p class="pwa-install-text"><strong>Install SiteStock</strong> for quicker access from your home screen or desktop - no app store, just one tap.</p>' +
        '<div class="pwa-install-actions">' +
          '<button type="button" class="btn btn-secondary" data-pwa="dismiss">Not now</button>' +
          '<button type="button" class="btn btn-primary" data-pwa="install">Install</button>' +
        '</div>';
    } else {
      banner.innerHTML =
        '<p class="pwa-install-text"><strong>Install SiteStock</strong> for quicker access: tap the Share icon, then "Add to Home Screen".</p>' +
        '<div class="pwa-install-actions">' +
          '<button type="button" class="btn btn-secondary" data-pwa="dismiss">Got it</button>' +
        '</div>';
    }
    banner.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pwa]');
      if (!btn) return;
      if (btn.dataset.pwa === 'dismiss') {
        setDismissed();
        removeBanner();
      } else if (btn.dataset.pwa === 'install' && deferredPrompt) {
        var p = deferredPrompt;
        deferredPrompt = null;
        removeBanner();
        p.prompt();
        // The outcome (accepted/dismissed) doesn't change our behaviour -
        // either way the browser won't offer this same prompt again until
        // it decides to, so there's nothing further to persist here.
        p.userChoice.catch(function () {});
      }
    });
    doc.body.appendChild(banner);
  }

  function maybeShow(kind) {
    if (!cookieChoiceMade()) {
      window.addEventListener('sitestock:cookie-choice-made', function () { maybeShow(kind); }, { once: true });
      return;
    }
    showBanner(kind);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    maybeShow('prompt');
  });

  window.addEventListener('appinstalled', function () {
    setDismissed(); // already installed - never ask again
    removeBanner();
  });

  function init() {
    if (isStandalone() || dismissed()) return;
    // iOS Safari gets no beforeinstallprompt event at all, so it's the one
    // path shown unconditionally (once cookie choice is made) rather than
    // waiting on an event that will never fire.
    if (isIosSafari()) maybeShow('ios');
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
