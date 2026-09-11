// Clickjacking defense-in-depth. This app's host (GitHub Pages) cannot set
// custom HTTP response headers, so the real fix - a Content-Security-Policy
// frame-ancestors directive, or the older X-Frame-Options header - is
// structurally unavailable here: frame-ancestors is spec-defined to be
// ignored entirely when delivered via a <meta> tag (the only delivery
// mechanism a static host without header control allows), and
// X-Frame-Options was never a valid meta http-equiv value in any browser.
//
// This script is the standard fallback for exactly that situation: if the
// page is loaded inside a frame, hide the document and try to break out to
// the top window - so a malicious site can't overlay/disguise real
// SiteStock controls (approve an order, delete a company, grant owner
// access, confirm a purchase, ...) to trick a logged-in visitor into
// clicking them without realising it.
//
// Loaded as the very first <script> on every page (right after the CSP
// meta tag), before any of the page's real content below it parses.
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  try {
    window.top.location = window.self.location.href;
  } catch (e) {
    // Cross-origin top window that also blocks navigation (a sandboxed
    // iframe without allow-top-navigation) - can't break out, but the
    // document stays hidden either way, which is the part that matters.
  }
}
