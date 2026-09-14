// Session recordings and heatmaps — Microsoft Clarity.
//
// Free with no traffic cap, and configured in the project's own dashboard
// Settings -> Masking as STRICT MODE, which redacts every piece of text on
// the page (names, addresses, postcodes, order details — everything) before
// it ever leaves the browser; only the shape of what was clicked/scrolled/
// typed into is recorded, never the content. See privacy.html section 5/6.
//
// Gated by the EXACT SAME "Allow analytics" cookie-notice choice as
// analytics.js's Cloudflare Web Analytics — not a second, separate consent —
// so the two always load (or don't) together.
//
// Live since 2026-09-14, project "sitestock". Masking mode set to Strict
// in the dashboard before this ID was pasted in, so the privacy.html
// promise held from the very first session recorded.
//
// Loaded as a plain classic <script> on index.html only (the app itself —
// session replay on the static legal pages would record nothing useful).
// The project ID is not a secret — Clarity's own embed snippet ships it in
// the page by design, same as the Cloudflare beacon token.
(function () {
  var CLARITY_PROJECT_ID = 'yiaeugmahi';
  var loaded = false;

  function consentGiven() {
    try { return localStorage.getItem('sitestock_cookie_choice') === 'all'; }
    catch (e) { return false; }
  }

  function load() {
    if (loaded) return;
    if (!CLARITY_PROJECT_ID) return;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
    if (!consentGiven()) return;
    loaded = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
  }

  // Try now (a returning visitor who already consented), and again the
  // moment consent is granted this session — same event analytics.js
  // listens for, so both loaders react to one "Allow analytics" click.
  load();
  window.addEventListener('sitestock:analytics-consent', load);
})();
