-- Beta operations (2/2): a global kill switch / maintenance flag.
--
-- One row (id = 1, enforced). Everyone (anon + authenticated) can READ it;
-- nobody can write it through the API - with no insert/update/delete policy,
-- only service_role can, i.e. the founder flips it from the Supabase
-- dashboard or SQL editor. No redeploy, effect on the next page load.
--
--   update public.app_status
--      set killed = true,
--          message = 'Back in ~30 minutes.',
--          updated_at = now()
--    where id = 1;
--
-- public/js/appStatus.js reads this during bootstrap and on window focus;
-- when `killed` is true, main.js shows a full-screen maintenance message
-- instead of the app. It FAILS OPEN - if the read errors (offline, etc.) the
-- app loads normally, so a transient Supabase blip can't lock everyone out.
--
-- Not in the _enforce_mfa_aal2 guard list (0040): it takes no client writes.
-- Not in the Realtime publication: a focus-triggered re-check is enough.

create table if not exists public.app_status (
  id          integer primary key default 1,
  killed      boolean not null default false,
  message     text not null default
    'SiteStock is briefly offline for maintenance. Please check back shortly.',
  updated_at  timestamptz not null default now(),
  constraint app_status_singleton check (id = 1)
);

insert into public.app_status (id) values (1) on conflict (id) do nothing;

alter table public.app_status enable row level security;

-- Read-only for clients. No insert/update/delete grant => the flag can only
-- be flipped by service_role (the Supabase dashboard / SQL editor).
grant select on public.app_status to anon, authenticated;

create policy app_status_read_any
  on public.app_status for select
  to anon, authenticated
  using (true);
