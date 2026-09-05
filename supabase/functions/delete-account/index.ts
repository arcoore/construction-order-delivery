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
// Deliberately NOT built here: any data anonymization/reassignment before
// deletion. profiles.id has no ON DELETE CASCADE from orders.requested_by_id,
// sites.created_by_id, or communities.owner_id (see supabase/migrations/
// 0002_profiles.sql, 0003_communities_and_membership.sql, 0004_sites.sql,
// 0005_orders_and_events.sql) — that's a deliberate database-level
// invariant protecting a company's real business records from silently
// disappearing because one person's account was deleted. The practical
// consequence: this function only succeeds for an account with genuinely no
// owned history (a fresh signup, essentially). Any account that has ever
// created a site, requested an order, or still owns a company gets a clear,
// honest refusal instead of a partial deletion or a corrupted record —
// resolving that case (transfer ownership? anonymize? both?) is a real
// product/legal decision that hasn't been made, not something to default
// silently in this function.

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

  // Deleting via a raw fetch to GoTrue's own admin REST endpoint rather than
  // supabase-js's admin.deleteUser() helper — verified live that the SDK
  // wraps a genuine Postgres foreign-key-violation response into a generic
  // {name: "AuthRetryableFetchError", message: "Database error deleting
  // user"}, discarding the real reason entirely. The raw endpoint's own JSON
  // body preserves the actual { code: "23503", message, detail } from
  // Postgres, which is what lets this function tell "you still own a
  // company" apart from "something genuinely went wrong" instead of
  // guessing.
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
        error: "Your account can't be deleted automatically because it still has activity on file — an order, a site, or a company you own. Contact support to arrange this manually.",
      }, 409);
    }
    return json({ error: 'Could not delete your account. Please try again or contact support.' }, 500);
  }

  return json({ ok: true }, 200);
});
