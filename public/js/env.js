// Loaded as a plain classic <script> BEFORE main.js's module script (see
// index.html) - module scripts always run after document parsing, so a
// synchronous classic script placed earlier is guaranteed to run first,
// setting window.SITESTOCK_SUPABASE_URL/ANON_KEY before supabaseClient.js
// reads them. No bundler, no env files, no build step - hostname is the
// only signal, evaluated once per page load.
(function () {
  var host = window.location.hostname;

  // Cloudflare Turnstile SITE key (not a secret - it's meant to ship in the
  // page). authView.js renders the widget on the login / register / reset
  // forms only when this is non-empty, and GoTrue only enforces the token
  // when [auth.captcha] enabled = true for that same backend. The two must
  // move together per environment: an enabled client gate against a backend
  // that ISN'T enforcing just adds a lockout risk (a visitor whose browser
  // blocks the Turnstile script can't get a token, so the client gate never
  // clears) for zero security gain.
  //
  //   local  - captcha is ON (config.toml [auth.captcha] enabled = true +
  //            TURNSTILE_SECRET in supabase/.env), so the key is set below.
  //   hosted - captcha is OFF until `supabase config push` carries the
  //            [auth.captcha] block to sitestock-dev. To turn it on there:
  //            run that push, THEN set the hosted branch's key to
  //            '0x4AAAAAAErzTvwChrSXq43-' (same widget, its hostnames already
  //            include arcoore.github.io).
  window.SITESTOCK_TURNSTILE_KEY = '';

  if (host === 'localhost' || host === '127.0.0.1') {
    window.SITESTOCK_TURNSTILE_KEY = '0x4AAAAAAErzTvwChrSXq43-';
    return; // local dev - supabaseClient.js's own local-Supabase defaults apply
  }

  if (host === 'arcoore.github.io') {
    window.SITESTOCK_SUPABASE_URL = 'https://jntbbrkiygbobknzivpe.supabase.co';
    window.SITESTOCK_SUPABASE_ANON_KEY = 'sb_publishable_aol6yne0oTut4gXGba9EAA_-07pkZhQ';
    // window.SITESTOCK_TURNSTILE_KEY = '0x4AAAAAAErzTvwChrSXq43-'; // enable after `config push`
    return;
  }

  // Fail safe: an unrecognized host must never silently fall back to local
  // Supabase (which would just hang against a real visitor) or be silently
  // routed to the hosted project without a deliberate decision.
  // supabaseClient.js checks this flag and refuses to start the app.
  window.SITESTOCK_SUPABASE_CONFIG_ERROR =
    'No Supabase backend is configured for this host ("' + host + '").';
})();
