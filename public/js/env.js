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
  // + localhost + 127.0.0.1) and its secret is in supabase/.env. Turned ON
  // 2026-09-11 as part of the pre-launch security pass - this key alone does
  // nothing without [auth.captcha] enabled = true also reaching the SAME
  // backend (see supabase/config.toml), which needs a `supabase config push`
  // that only the founder can run (see CLAUDE.md's harness-block note).
  window.SITESTOCK_TURNSTILE_KEY = '0x4AAAAAAErzTvwChrSXq43-';

  // Social sign-in providers the app is willing to show. This is only the
  // FIRST of two gates: authView.js also asks GoTrue's /auth/v1/settings
  // which providers are actually enabled, and a button appears only when
  // BOTH agree (see authView.js's wireSocialSignIn + auth.js's
  // getEnabledOAuthProviders). So listing a provider here is inert - no
  // button, no error - until it is ALSO enabled with real credentials in
  // supabase/config.toml's [auth.external.<provider>].
  //
  // google + azure are listed because they're free and the plan is to use
  // them (see supabase/OAUTH_SETUP.md for the register-the-app steps).
  // 'apple' is left out on purpose - it needs the $99/yr Apple Developer
  // Program, deferred until SiteStock is wrapped as a native app.
  // Accepted values: 'google', 'azure' (shown as "Microsoft"), 'apple'.
  window.SITESTOCK_OAUTH_PROVIDERS = ['google', 'azure'];

  if (host === 'localhost' || host === '127.0.0.1') {
    return; // local dev - supabaseClient.js's own local-Supabase defaults apply
  }

  if (host === 'arcoore.github.io') {
    // Migrated 2026-09-14 to the London-region project (was Ireland,
    // jntbbrkiygbobknzivpe) - see .tools/INFRA_MIGRATION_PLAN.md. Data,
    // migrations, and auth/security config all verified identical before
    // this switch; the old project is kept running, untouched, as a
    // fallback during the cooldown window.
    window.SITESTOCK_SUPABASE_URL = 'https://rcdrgoxtawlemhzmpcry.supabase.co';
    window.SITESTOCK_SUPABASE_ANON_KEY = 'sb_publishable_jBPbTsYSxIP3vi7Tspsu7g_OUEF6ige';
    return;
  }

  // Fail safe: an unrecognized host must never silently fall back to local
  // Supabase (which would just hang against a real visitor) or be silently
  // routed to the hosted project without a deliberate decision.
  // supabaseClient.js checks this flag and refuses to start the app.
  window.SITESTOCK_SUPABASE_CONFIG_ERROR =
    'No Supabase backend is configured for this host ("' + host + '").';
})();
