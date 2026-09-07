// Loaded as a plain classic <script> BEFORE main.js's module script (see
// index.html) - module scripts always run after document parsing, so a
// synchronous classic script placed earlier is guaranteed to run first,
// setting window.SITESTOCK_SUPABASE_URL/ANON_KEY before supabaseClient.js
// reads them. No bundler, no env files, no build step - hostname is the
// only signal, evaluated once per page load.
(function () {
  var host = window.location.hostname;

  // Cloudflare Turnstile SITE key (not a secret - it's designed to ship in the
  // page). authView.js renders the CAPTCHA widget on the login / register /
  // reset forms only when this is non-empty, and GoTrue only enforces the
  // token when [auth.captcha] enabled = true for that same backend. The two
  // MUST move together per environment: an enabled client gate against a
  // backend that isn't enforcing (or vice versa) just breaks login for anyone
  // whose browser blocks the Turnstile script, for zero security gain.
  //
  // The widget exists ("SiteStock" in Cloudflare; hostnames arcoore.github.io
  // + localhost + 127.0.0.1) and its secret is in supabase/.env, but it's
  // OFF everywhere for now - see supabase/config.toml's [auth.captcha] note
  // for the turn-it-on steps. When ready, set the key on the matching branch:
  //   window.SITESTOCK_TURNSTILE_KEY = '0x4AAAAAAErzTvwChrSXq43-';
  window.SITESTOCK_TURNSTILE_KEY = '';

  if (host === 'localhost' || host === '127.0.0.1') {
    return; // local dev - supabaseClient.js's own local-Supabase defaults apply
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
