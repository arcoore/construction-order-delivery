-- Free / Premium plans (product decision, 2026-09-15): every company starts
-- on the Free plan, capped at 2 sites. Premium removes the cap for
-- £10/month.
--
-- THIS IS A GATING-ONLY BUILD - there is no real payment collection yet.
-- Actually charging money needs a registered business and a payment
-- processor (Stripe), whose contracting party must be 18+ - the founder
-- isn't yet (see the launch-blockers memory). So `communities.premium` can
-- only ever be flipped by hand, from the Supabase dashboard/SQL editor,
-- once a real arrangement exists outside the app. It is deliberately NOT
-- self-serve: no RPC, no client write path, no Stripe webhook. When real
-- billing exists, whatever writes the webhook handler does can set this
-- same column the same way - the site-limit gating logic below doesn't
-- need to change at all.

alter table communities
  add column premium boolean not null default false;

-- Only a caller NOT going through the normal authenticated app API (i.e.
-- direct SQL - the Supabase dashboard, `psql`, or a future service-role
-- webhook) can change this column. current_user reflects the REAL active
-- Postgres role for this statement (PostgREST does a genuine `SET ROLE
-- authenticated` per request - see CLAUDE.md's statement_timeout note for
-- why this is the reliable signal, not a JWT claim string that could go
-- stale) - direct dashboard/psql access never runs as `authenticated` at
-- all, and a future service-role webhook would run as `service_role`, so
-- both pass straight through untouched. Mirrors app_status (0042)'s
-- "no write grant at all" pattern, just at column granularity, since
-- `communities` otherwise has real owner-writable columns
-- (require_owner_approval, discoverable, approval_threshold) on the same
-- row via communities_update_owner_only (0009).
create or replace function _guard_communities_premium()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.premium is distinct from old.premium and current_user = 'authenticated' then
    raise exception 'Premium can only be changed by SiteStock, not through the app.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger communities_guard_premium
  before update on communities
  for each row execute function _guard_communities_premium();

-- The cap itself. A site counts toward it unless it's archived - pausing or
-- completing a site doesn't free a slot (it's still in active use by the
-- company), only archiving does. Fires on INSERT (a brand new site) and on
-- UPDATE only when a site is coming OUT of 'archived' (restoring a site
-- back into use is the same "now using a slot" event as creating one - and
-- without this check a free-plan company could archive+restore to dodge the
-- cap entirely). A plain status change between two non-archived statuses,
-- or any other field edit, never re-triggers this - see the condition
-- below, which returns immediately for both.
create or replace function _enforce_site_plan_limit()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_premium boolean;
  v_count integer;
begin
  if new.status = 'archived' or (tg_op = 'UPDATE' and old.status <> 'archived') then
    return new;
  end if;

  -- FOR UPDATE serializes concurrent site creation for the same company, so
  -- two inserts that individually look fine can't both slip past a stale
  -- count - same discipline as _enforce_site_budget (0033).
  select premium into v_premium from communities where id = new.community_id for update;
  if v_premium then
    return new;
  end if;

  select count(*) into v_count from sites
    where community_id = new.community_id and status <> 'archived';

  if v_count >= 2 then
    raise exception 'Free plan is limited to 2 sites. Upgrade to Premium (£10/month) for unlimited sites.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger sites_enforce_plan_limit
  before insert or update on sites
  for each row execute function _enforce_site_plan_limit();
