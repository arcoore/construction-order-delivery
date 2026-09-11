// Dark mode. Two ways in, same as most phone OSes: automatically follow
// the device/browser's own dark-mode setting (the style.css
// `@media (prefers-color-scheme: dark)` block handles that with zero JS),
// or force it explicitly regardless of the device setting via this file's
// footer switch, stored in localStorage.
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
//   2. Inject the footer switch + Save control, which only makes sense
//      once the footer it attaches to actually exists - deferred to
//      DOMContentLoaded, same as cookieConsent.js's footer control.
//
// The switch itself is a display-only "what would I be choosing" control -
// flipping it does not apply or persist anything. Only Save does. This
// matches an ordinary settings-page pattern (change a control, then
// explicitly confirm) rather than the more surprising "every click takes
// effect immediately" a bare toggle button would have been.
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

  // What's actually being shown right now, resolving "follow system" down
  // to a real light/dark so the switch's starting position is honest.
  function effectiveTheme() {
    var stored = readChoice();
    if (stored === 'light' || stored === 'dark') return stored;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  // Step 1 - runs now, synchronously, before <body> exists.
  apply(readChoice());

  // Step 2 - the switch + Save control, once there's a footer to put it in.
  function injectFooterControl() {
    var footer = doc.querySelector('.app-footer-links, .legal-footer');
    if (!footer || footer.querySelector('[data-theme-switch]')) return;

    var startDark = effectiveTheme() === 'dark';

    var group = doc.createElement('span');
    group.className = 'theme-toggle-group';
    group.innerHTML =
      '<label class="theme-switch-label">' +
        '<input type="checkbox" data-theme-switch' + (startDark ? ' checked' : '') + '>' +
        '<span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>' +
        'Dark mode' +
      '</label>' +
      '<button type="button" class="theme-save-btn" data-theme-save disabled>Save</button>' +
      '<span class="theme-save-status" data-theme-status aria-live="polite"></span>';
    footer.appendChild(group);

    var checkbox = group.querySelector('[data-theme-switch]');
    var saveBtn = group.querySelector('[data-theme-save]');
    var status = group.querySelector('[data-theme-status]');
    var savedDark = startDark; // what's actually applied right now

    checkbox.addEventListener('change', function () {
      saveBtn.disabled = checkbox.checked === savedDark;
      status.textContent = '';
    });

    saveBtn.addEventListener('click', function () {
      var choice = checkbox.checked ? 'dark' : 'light';
      writeChoice(choice);
      apply(choice);
      savedDark = checkbox.checked;
      saveBtn.disabled = true;
      status.textContent = 'Saved';
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', injectFooterControl);
  } else {
    injectFooterControl();
  }
})();
