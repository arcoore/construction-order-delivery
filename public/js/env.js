// Loaded as a plain classic <script> BEFORE main.js's module script (see
// index.html) — module scripts always run after document parsing, so a
// synchronous classic script placed earlier is guaranteed to run first,
// setting window.SITESTOCK_SUPABASE_URL/ANON_KEY before supabaseClient.js
// reads them. No bundler, no env files, no build step — hostname is the
// only signal, evaluated once per page load.
(function () {
  var host = window.location.hostname;

  if (host === 'localhost' || host === '127.0.0.1') {
    return; // local dev — supabaseClient.js's own local-Supabase defaults apply
  }

  if (host === 'arcoore.github.io') {
    window.SITESTOCK_SUPABASE_URL = 'https://jntbbrkiygbobknzivpe.supabase.co';
    window.SITESTOCK_SUPABASE_ANON_KEY = 'sb_publishable_aol6yne0oTut4gXGba9EAA_-07pkZhQ';
    return;
  }

  // Fail safe: an unrecognized host must never silently fall back to local
  // Supabase (which would just hang against a real visitor) or be silently
  // routed to the hosted project without a deliberate decision.
  // supabaseClient.js checks this flag and refuses to start the app.
  window.SITESTOCK_SUPABASE_CONFIG_ERROR =
    'No Supabase backend is configured for this host ("' + host + '").';
})();
