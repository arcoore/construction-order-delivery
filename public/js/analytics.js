// Cookieless page-view analytics (GoatCounter).
//
// Privacy-first: no cookies, no fingerprinting, no cross-site tracking, no
// personal data - so no consent banner is required (see the Privacy Policy,
// "Cookies and local storage"). Counts page views only.
//
// Disabled until you set a code below:
//   1. Sign up free at https://www.goatcounter.com and pick a code
//      (that becomes your subdomain, e.g. "sitestock").
//   2. Set GOATCOUNTER_CODE to that code and redeploy.
//   3. View stats at https://<code>.goatcounter.com
//
// Loaded as a plain classic <script> on every page (app + legal pages).
(function () {
  var GOATCOUNTER_CODE = ''; // e.g. 'sitestock'
  if (!GOATCOUNTER_CODE) return;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.setAttribute('data-goatcounter', 'https://' + GOATCOUNTER_CODE + '.goatcounter.com/count');
  document.head.appendChild(s);
})();
