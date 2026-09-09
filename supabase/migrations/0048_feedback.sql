-- In-app feedback: a "Send feedback" box + a one-time gentle prompt after a
-- company's first completed delivery. The honest version of "ask for a
-- review at a key moment" — it goes to everyone and the message lands in a
-- private table only the operator can read.
--
-- Shape mirrors client_errors (0041): a flat, standalone, insert-only table,
-- no RPC, no Realtime, no read/update/delete grant — so it's
-- service_role-read-only (the operator reads it from the Supabase
-- dashboard). Differences from client_errors:
--   * authenticated only, never anon — feedback needs a real account, which
--     shrinks the abuse surface (the anon key is public; a JWT needs a
--     rate-limited signup + email confirmation first).
--   * a per-user cooldown, not just a global cap — the realistic abuse is
--     one account spamming, not a flood.
--   * NOT pruned — feedback is signal worth keeping; the guards below bound
--     runaway growth instead.
--   * NOT in the _enforce_mfa_aal2 guard list (0040) — same as client_errors,
--     leaving feedback while mid-2FA-challenge should still work; the rows
--     carry no company data.

create table if not exists public.feedback (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  -- Server-filled from the caller's JWT; the client never sends it.
  user_id      uuid default auth.uid() references auth.users (id) on delete set null,
  message      text not null,
  -- Where the prompt came from, so volunteered feedback is distinguishable
  -- from a prompted milestone response.
  context      text not null default 'general',
  path         text,
  app_version  text,
  constraint feedback_message_len  check (char_length(btrim(message)) between 1 and 4000),
  constraint feedback_context_valid check (context in ('general', 'milestone_first_delivery'))
);

create index if not exists feedback_created_at_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- INSERT only, authenticated only. No select/update/delete for anyone but
-- service_role.
grant insert on public.feedback to authenticated;

create policy feedback_insert_own
  on public.feedback for insert
  to authenticated
  with check (user_id = auth.uid());

-- ================================================================
-- Rate limiting: a per-user 20s cooldown (the real guard against one
-- account spamming — the client disables its button for the same window,
-- so a legit user never hits this) plus a generous global ceiling
-- (200 rows / rolling hour — a real beta never approaches that). Same
-- SECURITY-DEFINER-trigger shape as 0047's client_errors flood guard.
-- ================================================================
create or replace function _feedback_rate_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null
     and exists (
       select 1 from feedback
       where user_id = new.user_id and created_at > now() - interval '20 seconds'
     )
  then
    raise exception 'feedback: please wait a few seconds between messages' using errcode = '53400';
  end if;

  if (select count(*) from feedback where created_at > now() - interval '1 hour') >= 200 then
    raise exception 'feedback: too many submissions, throttled' using errcode = '53400';
  end if;

  return new;
end;
$$;
revoke execute on function _feedback_rate_guard() from public, anon, authenticated;

create trigger feedback_rate_guard
  before insert on feedback
  for each row execute function _feedback_rate_guard();
