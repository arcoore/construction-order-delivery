-- Premium billing (Stripe) - database half.
--
-- WHAT THIS IS. 0052 made the Free/Premium plan a gate (`communities.premium`,
-- 2-site cap) but left it a manual, dashboard-only flip because nobody adult
-- could contract with a payment processor yet. This migration is the missing
-- back half: the tables and functions that let a Stripe subscription switch
-- `communities.premium` on and off by itself. It is BUILT AND TESTED AGAINST A
-- MOCK STRIPE and stays dark in production: nothing in the app calls it until
-- window.SITESTOCK_BILLING.enabled is set (public/js/env.js) AND the three
-- Stripe secrets exist on the project (supabase/functions/_shared/stripe.ts).
--
-- The trust chain, end to end:
--   browser -> billing-checkout (Edge Function, caller's JWT) ->
--       billing_checkout_context() [is this caller an owner of THIS company?] ->
--       Stripe Checkout Session -> Stripe hosted page -> customer pays ->
--   Stripe -> billing-webhook (Edge Function, verifies Stripe's HMAC signature) ->
--       apply_billing_event() [service_role only] -> company_billing +
--       communities.premium.
-- The browser never writes any of it, and 0052's `_guard_communities_premium`
-- trigger still refuses an owner flipping `premium` themselves: it blocks only
-- current_user = 'authenticated', and apply_billing_event is SECURITY DEFINER
-- (runs as the function owner), which is exactly the path 0052 reserved.

-- ================================================================
-- 1. company_billing - one row per company that has ever started checkout
-- ================================================================
create table company_billing (
  community_id uuid primary key references communities (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  -- Mirrors Stripe's subscription.status vocabulary, plus 'none' before the
  -- first webhook lands.
  status text not null default 'none'
    check (status in ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active',
                      'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Stripe's own `created` (epoch seconds) of the newest event applied. Stripe
  -- does not guarantee delivery order, so an older event arriving late must not
  -- overwrite a newer state.
  last_event_created bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table company_billing enable row level security;

-- An owner may read their own company's plan state (to show a renewal date and
-- a "payment failed" warning) - but only the columns that are useful and safe:
-- the Stripe customer/subscription ids stay server-side. Column-level grant +
-- row-level policy; no INSERT/UPDATE/DELETE grant to any client role.
create policy company_billing_select_owner on company_billing
  for select to authenticated
  using (is_owner(community_id, auth.uid()));
revoke all on company_billing from public, anon, authenticated;
grant select (community_id, status, current_period_end, cancel_at_period_end, updated_at)
  on company_billing to authenticated;

-- ================================================================
-- 2. billing_events - webhook idempotency + audit trail
-- ================================================================
-- Stripe retries a webhook until it gets a 2xx, and may deliver the same event
-- twice. The primary key makes "already handled" a constant-time check.
-- community_id deliberately has NO foreign key: the record of what Stripe told
-- us must outlive a deleted company.
create table billing_events (
  stripe_event_id text primary key,
  event_type text not null,
  community_id uuid,
  outcome text not null check (outcome in ('applied', 'ignored_stale', 'ignored_unmatched')),
  received_at timestamptz not null default now()
);
alter table billing_events enable row level security;
revoke all on billing_events from public, anon, authenticated;

-- ================================================================
-- 3. billing_checkout_context - what the checkout/portal functions need to know
-- ================================================================
-- Called by the Edge Functions with the CALLER'S own JWT, so auth.uid() is the
-- person clicking "Upgrade". Putting the "may this person pay for this company"
-- decision in SQL (not in TypeScript) keeps it in one testable place, next to
-- every other owner check in the app.
create or replace function billing_checkout_context(p_community_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_premium boolean;
  v_billing company_billing%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not is_owner(p_community_id, auth.uid()) then
    raise exception 'only a company owner can manage billing' using errcode = '42501';
  end if;
  select name, premium into v_name, v_premium from communities where id = p_community_id;
  select * into v_billing from company_billing where community_id = p_community_id;
  return jsonb_build_object(
    'communityName', v_name,
    'premium', coalesce(v_premium, false),
    'customerId', v_billing.stripe_customer_id,
    'status', coalesce(v_billing.status, 'none')
  );
end;
$$;
revoke execute on function billing_checkout_context(uuid) from public, anon;
grant execute on function billing_checkout_context(uuid) to authenticated;

-- ================================================================
-- 4. apply_billing_event - the ONLY thing that turns a payment into `premium`
-- ================================================================
-- service_role only (the webhook function). Returns the outcome so the caller
-- can log it; raising is reserved for genuine faults (Stripe then retries).
--
-- Which statuses count as Premium: 'active', 'trialing', and 'past_due'.
-- past_due is Stripe's smart-retry window after a failed card charge - cutting
-- a company off on the first declined payment (an expired card, a bank hold)
-- would be needlessly hostile; Stripe moves it to 'unpaid'/'canceled' if the
-- retries all fail, and THAT switches Premium off.
--
-- Downgrading never deletes anything. The 2-site cap (0052) only fires when a
-- site is created or restored, so a company that lapses back to Free keeps the
-- sites it already has; it just can't add or restore more until it upgrades.
create or replace function apply_billing_event(
  p_event_id text,
  p_event_type text,
  p_event_created bigint,
  p_community_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_community uuid := p_community_id;
  v_existing company_billing%rowtype;
  v_inserted integer;
  v_status text;
begin
  if p_event_id is null or p_event_type is null then
    raise exception 'event id and type are required' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in
    ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused') then
    raise exception 'unknown subscription status' using errcode = '22023';
  end if;

  -- Idempotency first: a repeat delivery is a no-op.
  insert into billing_events (stripe_event_id, event_type, community_id, outcome)
  values (p_event_id, p_event_type, null, 'applied')
  on conflict (stripe_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 'duplicate';
  end if;

  -- The company: the id we put in Stripe's metadata when checkout started, or,
  -- for events that don't carry it, whichever company already owns that
  -- subscription/customer.
  if v_community is not null and not exists (select 1 from communities where id = v_community) then
    v_community := null;
  end if;
  if v_community is null then
    select community_id into v_community from company_billing
    where (p_subscription_id is not null and stripe_subscription_id = p_subscription_id)
       or (p_customer_id is not null and stripe_customer_id = p_customer_id)
    limit 1;
  end if;
  if v_community is null then
    update billing_events set outcome = 'ignored_unmatched' where stripe_event_id = p_event_id;
    return 'ignored_unmatched';
  end if;

  insert into company_billing (community_id) values (v_community) on conflict (community_id) do nothing;
  select * into v_existing from company_billing where community_id = v_community for update;

  if p_event_created < v_existing.last_event_created then
    update billing_events set community_id = v_community, outcome = 'ignored_stale' where stripe_event_id = p_event_id;
    return 'ignored_stale';
  end if;

  v_status := coalesce(p_status, v_existing.status);
  update company_billing set
    stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = coalesce(p_subscription_id, stripe_subscription_id),
    status = v_status,
    current_period_end = coalesce(p_current_period_end, current_period_end),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
    last_event_created = greatest(last_event_created, p_event_created),
    updated_at = now()
  where community_id = v_community;

  -- Only a status we actually learned changes the plan. A link-only event
  -- (status null) leaves `premium` exactly as it was.
  if p_status is not null then
    update communities set premium = (v_status in ('active', 'trialing', 'past_due'))
    where id = v_community and premium is distinct from (v_status in ('active', 'trialing', 'past_due'));
  end if;

  update billing_events set community_id = v_community where stripe_event_id = p_event_id;
  return 'applied';
end;
$$;
revoke execute on function apply_billing_event(text, text, bigint, uuid, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function apply_billing_event(text, text, bigint, uuid, text, text, text, timestamptz, boolean)
  to service_role;

-- ================================================================
-- 5. Don't let a company be deleted out from under a live subscription
-- ================================================================
-- delete_community (0038) is allowed on an empty company. If that company were
-- still paying, deleting it would cascade the billing row away while Stripe kept
-- charging the card - and the webhook could no longer find it. Refuse until the
-- subscription is cancelled (the owner does that from Company settings ->
-- Manage subscription). A cancelled/never-started company deletes as before.
create or replace function _guard_delete_community_billing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from company_billing
    where community_id = old.id
      and stripe_subscription_id is not null
      and status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')
  ) then
    raise exception 'This company has a Premium subscription. Cancel it first (Company settings > Manage subscription), then delete the company.'
      using errcode = '55006';
  end if;
  return old;
end;
$$;
revoke execute on function _guard_delete_community_billing() from public, anon, authenticated;
create trigger communities_guard_delete_billing
  before delete on communities
  for each row execute function _guard_delete_community_billing();
