// Self-service account deletion (product-audit gap fix).
//
// Why this has to be a server-side function at all: deleting a real
// auth.users row requires the Admin API, which requires the service_role
// key — and that key must never reach the browser (see CLAUDE.md's explicit
// guardrail: "don't ever ship the service_role key to the browser"). This
// function is the one place it's used, and it never leaves this runtime —
// it's read from the platform-managed SUPABASE_SERVICE_ROLE_KEY environment
// variable, never hardcoded, never logged, never returned in any response.
//
// Identity is verified independently of anything the caller claims: the
// incoming Authorization header (supabase-js's functions.invoke() forwards
// the caller's own current session there automatically) is handed to a
// plain anon-key client and resolved via auth.getUser(), which validates
// the JWT against Supabase Auth itself — the caller can only ever delete
// their own account, never an id they pass in (there is no id parameter
// accepted at all).
//
// Two steps, in order:
//   1. anonymize_own_account() — a SECURITY DEFINER RPC (migration 0045),
//      called with the caller's own JWT so auth.uid() is them. It scrubs
//      everything personal-only (notifications, preferences, pending
//      requests, browser error reports, live grants/site memberships),
//      ends their active company memberships ('left'), and marks
//      profiles.deleted_at — while KEEPING the profiles row and its
//      display_name so the person's name still reads correctly on their
//      company's historical orders/messages/events (founder decision,
//      2026-09-08). It refuses (SQLSTATE 42501) if the caller still owns a
//      company they created — they must transfer or delete it first.
//   2. the Admin API deletes the auth.users row itself (email, password
//      hash, sessions, MFA factors). 0045 dropped profiles' ON DELETE
//      CASCADE from auth.users, so this no longer takes the profile — and
//      client_errors.user_id (ON DELETE SET NULL) is the only remaining
//      reference, so it succeeds cleanly instead of hitting a foreign-key
//      violation the way the old delete-everything-or-nothing approach did.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: 'Server misconfiguration.' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'Authentication required.' }, 401);
  }

  // Identity-only client — never used to write anything, just to resolve
  // "who is genuinely making this call" from their own session token.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: 'Authentication required.' }, 401);
  }

  // Step 1: scrub the personal-only data and end memberships, as the caller.
  // A 42501 here is our deliberate "you still own a company" refusal (or an
  // auth failure, already ruled out above) — surface its message as a 409.
  const { error: scrubError } = await callerClient.rpc('anonymize_own_account');
  if (scrubError) {
    const status = scrubError.code === '42501' ? 409 : 500;
    return json({
      error: scrubError.message || 'Could not prepare your account for deletion.',
    }, status);
  }

  // Step 2: delete the auth.users row. Raw fetch to GoTrue's own admin REST
  // endpoint rather than supabase-js's admin.deleteUser() helper — verified
  // live that the SDK wraps a Postgres error into a generic
  // {name: "AuthRetryableFetchError", message: "Database error deleting
  // user"}, discarding the real reason; the raw endpoint's JSON body keeps
  // the actual { code, message, detail }.
  //
  // After step 1 and migration 0045 this should always succeed: the only
  // remaining reference to auth.users is client_errors.user_id (ON DELETE
  // SET NULL). A foreign-key failure here now means something is genuinely
  // wrong (a new un-cascaded reference was added without updating step 1) —
  // profiles.deleted_at is already set, so the personal data is scrubbed;
  // report it and let support finish the auth-row removal.
  const deleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userData.user.id}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!deleteResponse.ok) {
    const body = await deleteResponse.json().catch(() => ({}));
    const isForeignKeyViolation = body.code === '23503'
      || String(body.message || '').toLowerCase().includes('foreign key');
    if (isForeignKeyViolation) {
      return json({
        error: "Your personal data has been removed, but the final step needs support to finish. Email us and we'll complete it.",
      }, 409);
    }
    return json({ error: 'Could not delete your account. Please try again or contact support.' }, 500);
  }

  return json({ ok: true }, 200);
});
