// The ONLY place the Supabase client is instantiated. Every other module
// that needs Supabase imports `supabase` from here - never creates its own
// client, never imports the SDK directly. Keeps the boundary from CLAUDE.md's
// Phase 8B plan real: UI -> data/domain modules -> this client, nothing else
// talks to Supabase directly.
//
// No bundler/npm in this project (see CLAUDE.md). The Supabase JS SDK is
// VENDORED - the whole dependency tree lives in js/vendor/ as plain ES
// modules, so the app loads with zero external script requests (it used to
// import from esm.sh, which meant the login screen couldn't start until a
// third-party CDN responded). See js/vendor/README.md for what's there and
// how to regenerate it on a version bump. The pinned version is 2.115.0;
// re-run the vendor steps and re-test auth + realtime + a full order
// lifecycle when bumping it.
import { createClient } from './vendor/supabase-js.bundle.js';

// Local Supabase dev stack values (from `supabase status`), used until a real
// cloud project exists - see supabase/README.md. The anon/public key is safe
// to embed in frontend code (Supabase's own security model: RLS is the real
// boundary, not key secrecy) - this is also literally the fixed, publicly
// documented default anon key every local Supabase CLI stack uses, not a
// secret specific to this machine.
//
// Production values are NOT here yet - no cloud project exists (Phase 8B is
// local-only, per explicit direction). When one does, replace these two
// constants; there's no build step to inject an env var through, so an
// explicit, obvious constant swap in this one file is the intended
// mechanism, checked via window.SITESTOCK_SUPABASE_* first so a future
// deploy-time script tag can override without editing this file.
// Set by env.js (loaded before this module - see index.html) when the
// current hostname doesn't match a known environment. Fails closed rather
// than silently defaulting to local Supabase or guessing a backend.
if (window.SITESTOCK_SUPABASE_CONFIG_ERROR) {
  throw new Error('SiteStock: ' + window.SITESTOCK_SUPABASE_CONFIG_ERROR);
}

const SUPABASE_URL = window.SITESTOCK_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = window.SITESTOCK_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// --- Session token storage ---------------------------------------------
// This is a static site (GitHub Pages) with no server, so the token can't
// be an httpOnly cookie - it has to live where JS can reach it. What
// actually stops injected script from reading it is the strict
// Content-Security-Policy in every page's <head> (no inline/third-party
// scripts) plus the output-escaping sweep across the render code.
//
// Given that, we use sessionStorage, not localStorage: the token is never
// written to disk and is gone when the tab closes, so it can't be lifted
// off a shared machine afterwards or survive a browser restart. The cost is
// that each browser tab is its own session. The two non-secret UI pointers
// (active company / role) stay in localStorage - see community.js.
//
// When SiteStock has its own backend, switch to httpOnly + SameSite=strict
// cookies via @supabase/ssr. That is the real fix; this is the best a
// static SPA can do.
const sessionTokenStorage = {
  getItem(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { sessionStorage.setItem(key, value); } catch { /* storage blocked */ } },
  removeItem(key) { try { sessionStorage.removeItem(key); } catch { /* storage blocked */ } },
};

// One-time sweep: any browser that logged in before the switch above still
// has a supabase-js auth token sitting in localStorage (key shaped
// `sb-<ref>-auth-token`, plus older `supabase.auth.token` / PKCE
// `...-code-verifier` entries). supabase-js with a custom `storage` never
// reads or writes those again, so they're inert - but they're still auth
// material on disk, so clear them. This app's own localStorage keys are all
// `sitestock_*`, so an `sb-`/`supabase.auth` prefix match can't hit them.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && (/^sb-.*-auth-token/.test(k) || k === 'supabase.auth.token')) {
      localStorage.removeItem(k);
    }
  }
} catch { /* storage blocked - nothing to clean */ }

// detectSessionInUrl is true (Roadmap Step 5) so a Supabase password-recovery
// link's URL fragment is picked up automatically and fires a real
// PASSWORD_RECOVERY auth event (see auth.js) - this app has no other
// URL-fragment/hash usage anywhere to conflict with it. The one other
// URL-carried signal this phase adds, the invite-link `?join=` query
// parameter, deliberately uses the query string rather than the fragment for
// exactly this reason (see community.js's consumeJoinIntentFromUrl).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: sessionTokenStorage,
  },
});
