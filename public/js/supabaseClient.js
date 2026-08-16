// The ONLY place the Supabase client is instantiated. Every other module
// that needs Supabase imports `supabase` from here — never creates its own
// client, never imports the SDK directly. Keeps the boundary from CLAUDE.md's
// Phase 8B plan real: UI -> data/domain modules -> this client, nothing else
// talks to Supabase directly.
//
// No bundler/npm in this project (see CLAUDE.md) — the Supabase JS SDK is
// loaded as a plain ES module straight from esm.sh, which is the SDK's own
// documented buildless usage path, not a workaround. It's the same category
// of runtime network dependency this app already has for geo.js's
// postcodes.io calls, just for a library import instead of a fetch.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Local Supabase dev stack values (from `supabase status`), used until a real
// cloud project exists — see supabase/README.md. The anon/public key is safe
// to embed in frontend code (Supabase's own security model: RLS is the real
// boundary, not key secrecy) — this is also literally the fixed, publicly
// documented default anon key every local Supabase CLI stack uses, not a
// secret specific to this machine.
//
// Production values are NOT here yet — no cloud project exists (Phase 8B is
// local-only, per explicit direction). When one does, replace these two
// constants; there's no build step to inject an env var through, so an
// explicit, obvious constant swap in this one file is the intended
// mechanism, checked via window.SITESTOCK_SUPABASE_* first so a future
// deploy-time script tag can override without editing this file.
const SUPABASE_URL = window.SITESTOCK_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = window.SITESTOCK_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
