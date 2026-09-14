// Cookie / storage consent notice.
//
// SiteStock's storage footprint is small and honest:
//   - ESSENTIAL (no consent needed, never gated): the Supabase auth token
//     (sessionStorage) that keeps you signed in, plus a couple of UI-only
//     pointers (active company / active role) in localStorage. The app does
//     not work without these, so they are "strictly necessary" and are
//     never blocked by this notice.
//   - OPTIONAL: a cookieless, privacy-friendly page-view counter
//     (Cloudflare Web Analytics - see analytics.js and the Privacy Policy).
//     No cookies, no fingerprinting, no personal data, no cross-site
//     tracking. It only loads after an explicit "Allow analytics" here.
//
// Loaded as a plain classic <script> on every page (app + legal pages),
// after analytics.js. The banner markup and the footer "Cookie choices"
// re-open control are both injected from here so there is nothing to keep
// in sync across the eight HTML files.
(function () {
  var KEY = 'sitestock_cookie_choice'; // 'all' | 'essential'
  var doc = document;

  function readChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function writeChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode - fall through */ }
  }
  function clearChoice() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  // Resolve privacy.html against the same base the stylesheet loaded from,
  // so the link is correct from index, any legal page, or a deep-path 404.
  function privacyHref() {
    var css = doc.querySelector('link[rel="stylesheet"]');
    var base = css ? css.href.replace(/css\/style\.css.*$/, '') : (location.origin + '/');
    return base + 'privacy.html';
  }

  var banner = null;

  function removeBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
    doc.body.classList.remove('cookie-choice-pending');
  }

  function choose(value) {
    writeChoice(value);
    removeBanner();
    if (value === 'all') {
      // analytics.js listens for this and loads the counter now, without a
      // page reload.
      window.dispatchEvent(new CustomEvent('sitestock:analytics-consent'));
    }
    // pwaInstall.js waits for this before showing its own banner, so the
    // two never stack on a first visit.
    window.dispatchEvent(new CustomEvent('sitestock:cookie-choice-made'));
  }

  function showBanner() {
    if (banner) return;
    banner = doc.createElement('div');
    banner.id = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie and storage notice');
    banner.innerHTML =
      '<p class="cookie-banner-text">SiteStock keeps you signed in using essential browser storage &ndash; that is needed to use the app and is always on. We would also like to count page views with a <strong>cookieless</strong>, privacy-friendly tool: no cookies, no personal data, no tracking, no ads. Allow that? You can change this any time from &ldquo;Cookie choices&rdquo; in the footer. <a class="cookie-banner-link" href="' + privacyHref() + '">Privacy Policy</a></p>' +
      // Equal visual weight on both choices - no nudging toward consent.
      '<div class="cookie-banner-actions">' +
        '<button type="button" class="btn btn-secondary" data-cookie-choice="essential">Essential only</button>' +
        '<button type="button" class="btn btn-secondary" data-cookie-choice="all">Allow analytics</button>' +
      '</div>';
    banner.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cookie-choice]');
      if (btn) choose(btn.getAttribute('data-cookie-choice'));
    });
    doc.body.appendChild(banner);
    doc.body.classList.add('cookie-choice-pending');
  }

  // Footer "Cookie choices" re-open control - injected into whichever footer
  // this page has.
  function injectFooterControl() {
    var footer = doc.querySelector('.app-footer-links, .legal-footer');
    if (!footer || footer.querySelector('[data-cookie-settings]')) return;
    var el = doc.createElement('button');
    el.type = 'button';
    el.className = 'cookie-settings-btn';
    el.setAttribute('data-cookie-settings', '');
    el.textContent = 'Cookie choices';
    el.addEventListener('click', function () {
      clearChoice();
      showBanner();
      banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    footer.appendChild(el);
  }

  function init() {
    injectFooterControl();
    if (!readChoice()) showBanner();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
