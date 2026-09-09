// Cookieless page-view analytics (GoatCounter).
//
// Privacy-first: no cookies, no fingerprinting, no cross-site tracking, no
// personal data. It still only loads AFTER the visitor picks "Allow
// analytics" in the cookie notice (cookieConsent.js) - so with no choice, or
// "Essential only", nothing here runs.
//
// Disabled until you set a code below:
//   1. Sign up free at https://www.goatcounter.com and pick a code
//      (that becomes your subdomain, e.g. "sitestock").
//   2. Set GOATCOUNTER_CODE to that code and redeploy.
//   3. View stats at https://<code>.goatcounter.com
//
// Loaded as a plain classic <script> on every page (app + legal pages),
// before cookieConsent.js.
(function () {
  var GOATCOUNTER_CODE = ''; // e.g. 'sitestock'
  var loaded = false;

  function consentGiven() {
    try { return localStorage.getItem('sitestock_cookie_choice') === 'all'; }
    catch (e) { return false; }
  }

  function load() {
    if (loaded) return;
    if (!GOATCOUNTER_CODE) return;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
    if (!consentGiven()) return;
    loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://gc.zgo.at/count.js';
    s.setAttribute('data-goatcounter', 'https://' + GOATCOUNTER_CODE + '.goatcounter.com/count');
    document.head.appendChild(s);
  }

  // Try now (covers a returning visitor who already consented), and again the
  // moment consent is granted this session (cookieConsent.js dispatches this).
  load();
  window.addEventListener('sitestock:analytics-consent', load);
})();
