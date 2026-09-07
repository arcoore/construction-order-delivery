-- Beta operations (1/2): a place for the browser to report uncaught errors.
--
-- Deliberately minimal and standalone - no RPC, no Realtime, no trigger.
-- Any authenticated OR anonymous client may INSERT (an uncaught error can
-- happen before login, or on the login screen itself). Nobody can
-- SELECT/UPDATE/DELETE through the API: with no such policy, only
-- service_role (the Supabase dashboard / SQL editor) can read the log.
--
-- NOT added to the _enforce_mfa_aal2 guard list in 0040 on purpose: error
-- reporting has to keep working even while a 2FA user is mid-challenge
-- (still aal1). The rows carry no company data, so this widens nothing.
--
-- public/js/errorLog.js is the only writer; it inserts best-effort and
-- swallows every failure, and it never puts the URL query string or hash in
-- `path` (a password-recovery link carries its token there).

create table if not exists public.client_errors (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  -- Filled server-side from the caller's own JWT - the client never sends
  -- it, so it can't be spoofed or attributed to someone else. Null for an
  -- anonymous (logged-out) report.
  user_id      uuid default auth.uid() references auth.users (id) on delete set null,
  kind         text not null default 'error',
  message      text not null,
  stack        text,
  path         text,
  user_agent   text,
  app_version  text,
  extra        jsonb not null default '{}'::jsonb,
  constraint client_errors_kind_valid check (kind in ('error', 'unhandledrejection')),
  constraint client_errors_message_len check (char_length(message) <= 2000),
  constraint client_errors_stack_len   check (stack is null or char_length(stack) <= 8000)
);

create index if not exists client_errors_created_at_idx
  on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

-- Table-level privilege (RLS narrows this; without the grant PostgREST 401s
-- before a policy is even consulted). INSERT only - no select/update/delete
-- for anon or authenticated, so the log is service_role-read-only.
grant insert on public.client_errors to anon, authenticated;

-- Insert-only, for everyone. The row's user_id must be either null or the
-- caller's own id (the column default already guarantees this for a normal
-- insert that omits the field; the check stops a client from passing
-- someone else's id explicitly).
create policy client_errors_insert_any
  on public.client_errors for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
