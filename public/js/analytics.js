// Privacy-friendly page-view analytics — Cloudflare Web Analytics.
//
// Chosen because it is genuinely free with no usage cap and free for
// commercial use (GoatCounter's hosted service is free for non-commercial
// use only). It is cookieless: no cookies, no localStorage, no
// fingerprinting, no cross-site tracking, and it does not store visitor IP
// addresses. See https://developers.cloudflare.com/web-analytics/
//
// It still only loads AFTER the visitor picks "Allow analytics" in the
// cookie notice (cookieConsent.js) — so with no choice, or "Essential
// only", nothing here runs.
//
// Disabled until you set a token below:
//   1. Sign up free at https://dash.cloudflare.com (no card, no domain
//      needed) → Web Analytics → Add a site → "Manual installation".
//   2. Copy the token from the snippet it shows (data-cf-beacon {"token": …})
//      into CF_BEACON_TOKEN and redeploy.
//   3. View stats in the Cloudflare dashboard.
//
// Loaded as a plain classic <script> on every page (app + legal pages),
// before cookieConsent.js. The token is public by design (it ships in the
// page), so hardcoding it here is fine — same as GoatCounter's code was.
(function () {
  var CF_BEACON_TOKEN = '74cd69efcf6447ce9de033ff4e0ebf96';
  var loaded = false;

  function consentGiven() {
    try { return localStorage.getItem('sitestock_cookie_choice') === 'all'; }
    catch (e) { return false; }
  }

  function load() {
    if (loaded) return;
    if (!CF_BEACON_TOKEN) return;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
    if (!consentGiven()) return;
    loaded = true;
    var s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_BEACON_TOKEN }));
    document.head.appendChild(s);
  }

  // Try now (covers a returning visitor who already consented), and again the
  // moment consent is granted this session (cookieConsent.js dispatches this).
  load();
  window.addEventListener('sitestock:analytics-consent', load);
})();
