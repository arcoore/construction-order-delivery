-- Server-side translation of community.js / sites.js's permission
-- composites — kept as near-literal a mapping as possible so this file can
-- be reviewed side by side with the JS it replaces.
--
-- SECURITY DEFINER + a locked-down search_path is required here: these
-- functions are called from inside RLS policies on community_memberships /
-- owner_grants / buyer_grants / site_memberships, and those same tables
-- have their own RLS. Without SECURITY DEFINER, checking "is this user a
-- member" would recurse into the very policy being evaluated. Every
-- function is intentionally narrow (a single boolean-shaped read), so this
-- does not create a general RLS bypass — it only ever answers yes/no to a
-- fixed question, never returns row data itself.

create or replace function is_creator(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from communities
    where id = p_community_id and owner_id = p_user_id
  );
$$;

create or replace function has_owner_grant(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from owner_grants
    where community_id = p_community_id and user_id = p_user_id
  );
$$;

-- The function almost everything else should call — is_creator is only for
-- gating the Team grant/revoke UI itself, exactly as in community.js.
create or replace function is_owner(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_creator(p_community_id, p_user_id) or has_owner_grant(p_community_id, p_user_id);
$$;

create or replace function is_approved_member(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner(p_community_id, p_user_id) or exists (
    select 1 from community_memberships
    where community_id = p_community_id and user_id = p_user_id and status = 'approved'
  );
$$;

-- Deliberately NOT owner-bypassed here (mirrors community.js's isBuyer,
-- which has no owner bypass) — the bypass is applied at the composite level
-- below (can_purchase_for_site), exactly matching the JS split between
-- isBuyer (no bypass) and canPurchaseForSite (has bypass).
create or replace function has_buyer_grant(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from buyer_grants
    where community_id = p_community_id and user_id = p_user_id
  );
$$;

create or replace function is_site_member(p_site_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from site_memberships
    where site_id = p_site_id and user_id = p_user_id
  );
$$;

-- Every composite below independently re-derives the site's real
-- community_id via the sites table itself (not trusting the caller's
-- p_community_id in isolation) — the exact cross-community guard that was a
-- real caught bug during the prototype's own Phase 4A verification. The
-- composite (site_id, community_id) foreign key in 0004 makes the
-- underlying data invariant impossible to violate in the first place; this
-- EXISTS check is the second, independent layer on top of that.

create or replace function can_access_site(p_site_id uuid, p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sites where id = p_site_id and community_id = p_community_id
  ) and (
    is_owner(p_community_id, p_user_id) or is_site_member(p_site_id, p_user_id)
  );
$$;

create or replace function can_create_order_for_site(p_site_id uuid, p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sites
    where id = p_site_id and community_id = p_community_id and status = 'active'
  ) and (
    is_owner(p_community_id, p_user_id)
    or (is_approved_member(p_community_id, p_user_id) and is_site_member(p_site_id, p_user_id))
  );
$$;

create or replace function can_purchase_for_site(p_site_id uuid, p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sites where id = p_site_id and community_id = p_community_id
  ) and (
    is_owner(p_community_id, p_user_id)
    or (has_buyer_grant(p_community_id, p_user_id) and is_site_member(p_site_id, p_user_id))
  );
$$;

-- Drivers are deliberately NOT site-scoped (matches the prototype's
-- explicit "Drivers get no site permission function at all, on purpose" —
-- any approved member of the community may claim/collect/deliver any
-- purchased order regardless of site membership).
create or replace function can_act_as_driver(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_approved_member(p_community_id, p_user_id);
$$;
