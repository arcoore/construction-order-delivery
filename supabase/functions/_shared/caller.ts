// Resolves "who is making this call" for the billing Edge Functions - the same
// technique delete-account uses: hand the caller's own Authorization header to
// an anon-key client and let Supabase Auth validate the JWT. Nothing the caller
// puts in the request body is ever trusted as an identity.
import { createClient, type SupabaseClient, type User } from 'https://esm.sh/@supabase/supabase-js@2';

export type CallerResult =
  | { ok: true; client: SupabaseClient; user: User }
  | { ok: false; status: number; error: string };

export async function authenticateCaller(req: Request): Promise<CallerResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return { ok: false, status: 500, error: 'Server misconfiguration.' };

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { ok: false, status: 401, error: 'Authentication required.' };

  const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return { ok: false, status: 401, error: 'Authentication required.' };
  return { ok: true, client, user: data.user };
}
