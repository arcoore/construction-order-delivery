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

grant usage on schema tests to authenticated, anon;
grant execute on function tests.create_user(text, text) to authenticated, anon;
grant execute on function tests.authenticate_as(uuid) to authenticated, anon;
grant execute on function tests.clear_authentication() to authenticated, anon;

-- This file is pure setup (schema + helper functions), not a real test —
-- but `supabase test db` runs every .sql file in this directory through
-- pg_prove, which expects each one to emit a TAP plan. A trivial one here
-- keeps the overall suite's exit code meaningful (0 only when every real
-- assertion, in every real test file, actually passed) instead of always
-- failing on this file regardless of the real tests' results.
select plan(1);
select pass('00_helpers.sql: schema and functions loaded');
select finish();
