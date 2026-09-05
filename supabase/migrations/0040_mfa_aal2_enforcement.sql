-- Server-side enforcement of two-factor sign-in (account security, 2026-09).
--
-- Supabase-native TOTP MFA gives the app a client-side gate: after a
-- password login the session is aal1, and the frontend won't route into the
-- app until the 6-digit code steps it up to aal2. That stops the realistic
-- attack (someone logging into the website with a leaked password).
--
-- This migration adds the belt-and-braces server side: a BEFORE
-- INSERT/UPDATE/DELETE trigger on every write-bearing table that refuses the
-- write when the caller HAS a verified MFA factor but the current request is
-- still aal1 — so a stolen password plus a hand-crafted aal1 API call (past
-- the frontend) also can't place/approve orders, touch the company, message,
-- or change membership.
--
-- Notes:
--   * A caller with NO verified MFA factor is completely unaffected — the
--     exists() is false and the trigger returns immediately. 2FA is opt-in.
--   * auth.uid()/auth.jwt() inside the trigger reflect the ORIGINAL request
--     (PostgREST's request GUC), not the SECURITY DEFINER function's role, so
--     this covers every RPC-driven write without touching a single RPC body.
--   * The superuser/service_role/migration path has auth.uid() null → skipped.
--   * pgTAP's tests.authenticate_as sets no aal claim and its users have no
--     mfa_factors row, so the whole test suite is unaffected.

-- SECURITY DEFINER: it must read auth.mfa_factors regardless of the caller's
-- role (the `authenticated` role has no grant on that table).
create or replace function _enforce_mfa_aal2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_aal text;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  begin
    v_aal := coalesce(auth.jwt() ->> 'aal', 'aal1');
  exception when others then
    v_aal := 'aal1';
  end;
  if v_aal <> 'aal2'
     and exists (
       select 1 from auth.mfa_factors
       where user_id = auth.uid() and status = 'verified'
     )
  then
    raise exception 'Finish two-factor sign-in before making this change.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
  guarded text[] := array[
    'orders', 'order_items', 'order_events', 'order_messages', 'delivery_photos',
    'cancellation_requests',
    'communities', 'community_memberships', 'community_membership_events',
    'owner_grants', 'buyer_grants', 'buyer_requests',
    'sites', 'site_memberships',
    'notifications', 'notification_preferences',
    'profiles'
  ];
begin
  foreach t in array guarded loop
    execute format('drop trigger if exists mfa_aal2_guard on public.%I', t);
    execute format(
      'create trigger mfa_aal2_guard before insert or update or delete on public.%I
       for each row execute function _enforce_mfa_aal2()', t);
  end loop;
end $$;
