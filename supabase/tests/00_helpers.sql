-- Test-only helpers. Never applied to a real environment — these live
-- outside supabase/migrations/ on purpose, loaded only by the pgTAP test
-- runner (`supabase test db` / `pg_prove`), never by `supabase db push`.
--
-- Simulates an authenticated request the same way Supabase's own RLS
-- testing guidance does: auth.uid() reads request.jwt.claims ->> 'sub', so
-- setting that GUC for the current transaction is enough to test policies
-- exactly as they'd behave against a real JWT, without needing a real
-- HTTP round trip through GoTrue.

create schema if not exists tests;

-- create_user is SECURITY DEFINER (it needs elevated rights to insert into
-- auth.users, which `authenticated` must never be able to do under normal
-- RLS). authenticate_as/clear_authentication are deliberately NOT — Postgres
-- explicitly forbids setting the `role` GUC from inside a SECURITY DEFINER
-- function (a real restriction hit during local verification, Phase 8A.5:
-- "cannot set parameter role within security-definer function" — allowing
-- it would let a definer function silently escalate the caller's role,
-- which is exactly the privilege-escalation shape SECURITY DEFINER
-- restrictions exist to prevent). Instead, correctness here rests entirely
-- on the explicit GRANT EXECUTE below: without it, calling
-- tests.authenticate_as() a SECOND time within one test file fails once the
-- first call has already switched the session to `authenticated`, which
-- never had USAGE on the `tests` schema at all — the very mechanism used to
-- switch identities broke after the first switch. Every test file that
-- authenticates as more than one user failed on the second switch until
-- this was fixed.

create or replace function tests.create_user(p_email text, p_display_name text)
returns uuid
language plpgsql security definer as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
  values (v_id, p_email, 'not-a-real-hash', now(), now(), now(), jsonb_build_object('display_name', p_display_name));
  -- profiles row is created by the 0002 trigger.
  return v_id;
end;
$$;

create or replace function tests.authenticate_as(p_user_id uuid)
returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function tests.clear_authentication()
returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Added alongside migration 0022, which drops
-- community_memberships_decide_owner_only (the old direct-UPDATE policy)
-- once decide_join_request became the sole authoritative decision path.
-- Several existing test files' fixture setup (not the thing actually under
-- test in those files — e.g. "get this worker approved so we can test
-- order creation") used to rely on that policy to flip a membership's
-- status directly, as the owner. Routing every one of those fixture
-- shortcuts through the real decide_join_request RPC instead would work
-- for a plain pending->approved setup, but not for 01_isolation_and_
-- permissions.sql's item 17, which deliberately simulates an already-
-- decided membership being changed again (a hypothetical revoke-style
-- status flip that isn't itself a join decision, and which the real RPC's
-- own state-machine guard would now correctly refuse to replay) — so a
-- genuine RLS-bypassing test-only helper is the right tool here, the exact
-- same category tests.create_user already is for auth.users, not a sign
-- that the underlying RLS closure was wrong.
create or replace function tests.set_membership_status(p_community_id uuid, p_user_id uuid, p_status membership_status, p_decided_by_id uuid default null)
returns void
language plpgsql security definer as $$
begin
  update community_memberships set
    status = p_status,
    decided_at = case when p_status = 'pending' then null else now() end,
    decided_by_id = p_decided_by_id
  where community_id = p_community_id and user_id = p_user_id;
end;
$$;

grant usage on schema tests to authenticated, anon;
grant execute on function tests.create_user(text, text) to authenticated, anon;
grant execute on function tests.authenticate_as(uuid) to authenticated, anon;
grant execute on function tests.clear_authentication() to authenticated, anon;
grant execute on function tests.set_membership_status(uuid, uuid, membership_status, uuid) to authenticated, anon;

-- This file is pure setup (schema + helper functions), not a real test —
-- but `supabase test db` runs every .sql file in this directory through
-- pg_prove, which expects each one to emit a TAP plan. A trivial one here
-- keeps the overall suite's exit code meaningful (0 only when every real
-- assertion, in every real test file, actually passed) instead of always
-- failing on this file regardless of the real tests' results.
select plan(1);
select pass('00_helpers.sql: schema and functions loaded');
select finish();
