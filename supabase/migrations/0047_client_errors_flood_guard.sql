-- Flood guard + retention for client_errors — the ONLY endpoint reachable
-- with just the public anon key that writes to the database.
--
-- THE GAP
-- -------
-- `grant insert on client_errors to anon` (migration 0041) is deliberate:
-- an uncaught error can happen on the login screen before any session
-- exists. But the public anon key is embedded in the frontend JS, so a
-- script can POST to /rest/v1/client_errors in a loop with no account, no
-- CAPTCHA, and — until now — no server-side ceiling. public/js/errorLog.js
-- caps itself at 12 rows per page load and de-dupes, but that is a courtesy
-- the real client extends, not a limit an attacker is bound by. A sustained
-- flood would fill the database (500 MB on the free tier) and take the whole
-- app down — a cheap application-layer DoS.
--
-- Every other write path needs a valid JWT (RLS-scoped direct writes, or a
-- SECURITY DEFINER RPC), and the auth endpoints that mint those JWTs are
-- already rate-limited per IP by GoTrue (config.toml [auth.rate_limit]:
-- sign_in_sign_ups=30, token_verifications=30, token_refresh=150,
-- email_sent=60). Volumetric / network-layer DDoS is absorbed upstream —
-- GitHub Pages sits behind Fastly, the Supabase API behind its own
-- Cloudflare/AWS edge. True per-IP rate limiting and a WAF for the REST API
-- need a Cloudflare proxy in front of a custom domain (Snagging List item
-- "host-edge-shield"); this migration closes the one hole that doesn't need
-- the domain first.

-- ================================================================
-- 1. Flood guard: a global cap on how fast rows can arrive.
--
--    BEFORE INSERT, refuse once >= 500 rows have landed in the last 60s.
--    A real beta has well under 500 genuine error reports a minute even in
--    a bad-release spike (20 users x 12 client-capped = 240), so legit
--    reporting is never throttled; a flood is stopped the moment it starts
--    and the table simply stops growing. Error reporting is best-effort and
--    errorLog.js swallows every failure, so a throttled minute degrades
--    gracefully with nothing user-visible.
--
--    SECURITY DEFINER: the trigger must SELECT from client_errors, which
--    anon/authenticated cannot do (insert-only table).
-- ================================================================
create or replace function _client_errors_flood_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from client_errors where created_at > now() - interval '60 seconds') >= 500 then
    raise exception 'client_errors: too many reports, throttled' using errcode = '53400';
  end if;
  return new;
end;
$$;
revoke execute on function _client_errors_flood_guard() from public, anon, authenticated;

create trigger client_errors_flood_guard
  before insert on client_errors
  for each row execute function _client_errors_flood_guard();

-- ================================================================
-- 2. Retention: bound the table's total size regardless of insert rate.
--
--    Keep the newest 10,000 rows, and nothing older than 30 days. Even at
--    the flood-guard's ceiling an attacker just churns the same 10k rows;
--    the table can't exceed ~10-100 MB. Also fixes the pre-existing
--    unbounded-growth issue (client_errors never had a prune, unlike
--    notifications since 0029). The founder reads this log from the
--    Supabase dashboard; 10k recent errors is ample beta history.
--
--    Same shape as prune_notifications() (0029) — maintenance function,
--    no EXECUTE grant, run by pg_cron or an admin.
-- ================================================================
create or replace function prune_client_errors()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from client_errors
  where created_at < now() - interval '30 days'
     or id not in (
       select id from client_errors order by created_at desc limit 10000
     );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke execute on function prune_client_errors() from public, anon, authenticated;

-- pg_cron was created in 0029 (and, on hosted, must be enabled in the
-- dashboard first — see 0029's header). This is idempotent by job name.
create extension if not exists pg_cron;
select cron.schedule('prune-client-errors', '43 3 * * *', 'select prune_client_errors();');
