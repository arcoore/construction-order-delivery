// Dark mode. Two ways in, same as most phone OSes: automatically follow
// the device/browser's own dark-mode setting (the style.css
// `@media (prefers-color-scheme: dark)` block handles that with zero JS),
// or force it explicitly regardless of the device setting via this file's
// footer toggle, stored in localStorage.
//
// This file does two genuinely different things at two genuinely different
// times:
//   1. Apply the stored choice to <html data-theme="..."> IMMEDIATELY, as
//      the very first thing that runs. It must be a plain classic <script>
//      loaded first in <head> (this project's CSP has no 'unsafe-inline',
//      so it can't be an inline <script> the way most "avoid a flash of
//      the wrong theme" snippets are written) - loaded any later (e.g. at
//      the bottom of <body>, where main.js/analytics.js/cookieConsent.js
//      all sit) would paint the page in the wrong theme first and flip
//      partway through.
//   2. Inject the footer toggle button, which only makes sense once the
//      footer it attaches to actually exists - deferred to DOMContentLoaded,
//      same as cookieConsent.js's footer control.
(function () {
  var KEY = 'sitestock_theme'; // 'light' | 'dark' | absent = follow system
  var doc = document;

  function readChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function writeChoice(v) {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (e) { /* private mode - fall through, just won't persist */ }
  }

  function apply(choice) {
    if (choice === 'light' || choice === 'dark') {
      doc.documentElement.setAttribute('data-theme', choice);
    } else {
      doc.documentElement.removeAttribute('data-theme');
    }
  }

  // Step 1 - runs now, synchronously, before <body> exists.
  apply(readChoice());

  // Step 2 - the actual toggle control, once there's a footer to put it in.
  function label(choice) {
    if (choice === 'dark') return 'Dark mode: on';
    if (choice === 'light') return 'Dark mode: off';
    return 'Dark mode: auto';
  }

  function injectFooterControl() {
    var footer = doc.querySelector('.app-footer-links, .legal-footer');
    if (!footer || footer.querySelector('[data-theme-toggle]')) return;
    var el = doc.createElement('button');
    el.type = 'button';
    el.className = 'theme-toggle-btn';
    el.setAttribute('data-theme-toggle', '');
    el.textContent = label(readChoice());
    el.addEventListener('click', function () {
      // Cycles auto -> dark -> light -> auto. "Auto" first because that's
      // the everyday phone-app behaviour this was asked to match; the
      // explicit choices are the override for anyone who wants one theme
      // regardless of the device setting.
      var current = readChoice();
      var next = current === 'dark' ? 'light' : (current === 'light' ? null : 'dark');
      writeChoice(next);
      apply(next);
      el.textContent = label(next);
    });
    footer.appendChild(el);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', injectFooterControl);
  } else {
    injectFooterControl();
  }
})();
