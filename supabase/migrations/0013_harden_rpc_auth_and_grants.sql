-- Phase 8C.5 — security hotfix. Forward-only; 0010/0011/0012 are NOT edited.
--
-- ROOT CAUSE (found via hosted cloud verification, not local testing):
-- 0011_grants.sql revoked EXECUTE from public/anon on every function that
-- existed AT THAT POINT in migration history, then granted authenticated-
-- only access back to a fixed list — including the original 5-parameter
-- edit_order. 0012_widen_edit_order.sql later dropped that 5-parameter
-- function and created a NEW 17-parameter edit_order (a different function
-- object/OID in Postgres). Because that function didn't exist yet when
-- 0011's blanket revoke ran, it never inherited the revoke — it kept
-- Postgres's default "EXECUTE granted to PUBLIC on function creation"
-- behavior instead. 0012's own closing `grant ... to authenticated` never
-- paired it with the missing `revoke ... from public, anon`. Verified
-- directly against the hosted project via has_function_privilege(): every
-- other lifecycle RPC correctly returns anon_can_execute = false; edit_order
-- alone returned true.
--
-- Combined with a second, independent issue — every ownership check in
-- these functions that compares a stored actor id directly against
-- auth.uid() (e.g. `v_order.requested_by_id != auth.uid()`) uses a raw `!=`.
-- In SQL, `anything != NULL` evaluates to NULL, and PL/pgSQL treats a NULL
-- IF-condition as not-true — the branch (the `raise exception`) is simply
-- skipped. auth.uid() is NULL for an unauthenticated (anon-role) caller, so
-- the grant gap above turned into a real, live bypass: an anonymous caller
-- could invoke edit_order with any order id + its current version and have
-- the ownership check silently pass, then apply their patch.
--
-- This migration closes both, and hardens every other order-lifecycle RPC
-- against the same class of mistake as defense in depth, even where the
-- current grant state doesn't currently allow it to be triggered — a future
-- migration that drops/recreates one of these without remembering the
-- revoke should not be able to reopen this hole silently.
--
-- Two changes per function, applied via CREATE OR REPLACE (preserves the
-- function's OID and existing grants — this is the standard, safe,
-- additive way to patch a function body without a DROP):
--   1. An explicit `if auth.uid() is null then raise exception ... end if;`
--      as the first statement, so every protected RPC fails closed before
--      any permission check even runs, rather than relying on downstream
--      logic (composite functions like is_owner/can_purchase_for_site
--      already happen to be NULL-safe because they wrap their checks in
--      EXISTS(), which returns false rather than null — but an explicit
--      upfront guard doesn't depend on that subtlety being preserved by
--      whoever edits these next).
--   2. Every raw `stored_id != auth.uid()` ownership comparison changed to
--      `stored_id is distinct from auth.uid()` — NULL-safe on BOTH sides,
--      so a null stored column (e.g. an order with no driver assigned yet)
--      can no longer produce the same silently-skipped-exception shape
--      either. Comparisons that are not identity checks (version numbers,
--      site-id-changed detection, request status) are deliberately left as
--      plain `!=`/`is distinct from` exactly as they already were — this is
--      a security patch, not a behavior change, and both forms already
--      existed side by side in 0012 for non-identity checks.

-- ============================================================ create_order
create or replace function create_order(
  p_community_id uuid,
  p_site_id uuid,
  p_product_id text,
  p_product_name text,
  p_variant text,
  p_quantity numeric,
  p_unit text,
  p_delivery_postcode text,
  p_delivery_lat double precision,
  p_delivery_lon double precision,
  p_stockist_id text,
  p_stockist_name text,
  p_stockist_website text,
  p_stockist_postcode text,
  p_pickup_estimate text,
  p_unit_price numeric
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_site sites%rowtype;
  v_community communities%rowtype;
  v_status order_status;
  v_approval_required boolean;
  v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not can_create_order_for_site(p_site_id, p_community_id, auth.uid()) then
    raise exception 'not authorized to order for this site' using errcode = '42501';
  end if;

  select * into v_site from sites where id = p_site_id;
  select * into v_community from communities where id = p_community_id;
  v_approval_required := v_community.require_owner_approval;
  v_status := case when v_approval_required then 'pending_approval' else 'pending_purchase' end;

  insert into orders (
    community_id, site_id, site_name, site_address, site_postcode, site_delivery_instructions,
    product_id, product_name, variant, quantity, unit,
    delivery_postcode, delivery_lat, delivery_lon,
    requested_by_id, requested_by, status, approval_was_required,
    stockist_id, stockist_name, stockist_website, stockist_postcode, pickup_estimate,
    unit_price, total_price
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    p_product_id, p_product_name, p_variant, p_quantity, p_unit,
    p_delivery_postcode, p_delivery_lat, p_delivery_lon,
    auth.uid(), _current_display_name(), v_status, v_approval_required,
    p_stockist_id, p_stockist_name, p_stockist_website, p_stockist_postcode, p_pickup_estimate,
    p_unit_price, p_unit_price * p_quantity
  ) returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (v_order.id, p_community_id, 'order_created', auth.uid(), _current_display_name(), null, v_status);

  return v_order;
end;
$$;

-- =============================================================== edit_order
-- Widened (17-param) signature from 0012, patched in place — this is the
-- exact function the exploit targeted. IMMEDIATE FIX: the null-guard below,
-- the is-distinct-from ownership check below, AND the explicit
-- revoke/grant block at the end of this file (Postgres's CREATE OR REPLACE
-- does not touch existing ACL entries, so the stray PUBLIC grant from
-- 0012 would otherwise survive this body patch untouched).
create or replace function edit_order(
  p_order_id uuid,
  p_expected_version integer,
  p_product_id text,
  p_product_name text,
  p_variant text,
  p_quantity numeric,
  p_unit text,
  p_delivery_postcode text,
  p_delivery_lat double precision,
  p_delivery_lon double precision,
  p_site_id uuid,
  p_stockist_id text,
  p_stockist_name text,
  p_stockist_website text,
  p_stockist_postcode text,
  p_pickup_estimate text,
  p_unit_price numeric
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_site sites%rowtype;
  v_action text;
  v_new_status order_status;
  v_changes jsonb := '{}'::jsonb;
  v_new_total_price numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id is distinct from auth.uid() then
    raise exception 'only the requester may edit this order' using errcode = '42501';
  end if;
  if v_order.version != p_expected_version then
    raise exception 'stale order version, refresh and try again' using errcode = '40001';
  end if;

  if v_order.status = 'pending_approval'
     or (v_order.status = 'pending_purchase' and v_order.approved_by_id is null) then
    v_action := 'edit';
    v_new_status := v_order.status;
  elsif v_order.status = 'pending_purchase' and v_order.approved_by_id is not null then
    v_action := 'edit_and_reapprove';
    v_new_status := 'pending_approval';
  else
    raise exception 'this order can no longer be edited' using errcode = '42501';
  end if;

  if p_site_id != v_order.site_id then
    if not can_create_order_for_site(p_site_id, v_order.community_id, auth.uid()) then
      raise exception 'not authorized to move this order to that site' using errcode = '42501';
    end if;
    select * into v_site from sites where id = p_site_id;
    v_changes := v_changes || jsonb_build_object('siteId', jsonb_build_object('from', v_order.site_id, 'to', p_site_id));
    v_changes := v_changes || jsonb_build_object('siteName', jsonb_build_object('from', v_order.site_name, 'to', v_site.name));
    v_changes := v_changes || jsonb_build_object('siteAddress', jsonb_build_object('from', v_order.site_address, 'to', v_site.address));
    v_changes := v_changes || jsonb_build_object('sitePostcode', jsonb_build_object('from', v_order.site_postcode, 'to', v_site.postcode));
    v_changes := v_changes || jsonb_build_object('siteDeliveryInstructions', jsonb_build_object('from', v_order.site_delivery_instructions, 'to', v_site.delivery_instructions));
  end if;

  if p_product_id is distinct from v_order.product_id then
    v_changes := v_changes || jsonb_build_object('productId', jsonb_build_object('from', v_order.product_id, 'to', p_product_id));
  end if;
  if p_product_name is distinct from v_order.product_name then
    v_changes := v_changes || jsonb_build_object('productName', jsonb_build_object('from', v_order.product_name, 'to', p_product_name));
  end if;
  if p_variant is distinct from v_order.variant then
    v_changes := v_changes || jsonb_build_object('variant', jsonb_build_object('from', v_order.variant, 'to', p_variant));
  end if;
  if p_quantity is distinct from v_order.quantity then
    v_changes := v_changes || jsonb_build_object('quantity', jsonb_build_object('from', v_order.quantity, 'to', p_quantity));
  end if;
  if p_unit is distinct from v_order.unit then
    v_changes := v_changes || jsonb_build_object('unit', jsonb_build_object('from', v_order.unit, 'to', p_unit));
  end if;
  if p_delivery_postcode is distinct from v_order.delivery_postcode then
    v_changes := v_changes || jsonb_build_object('deliveryPostcode', jsonb_build_object('from', v_order.delivery_postcode, 'to', p_delivery_postcode));
  end if;
  if p_stockist_id is distinct from v_order.stockist_id then
    v_changes := v_changes || jsonb_build_object('stockistId', jsonb_build_object('from', v_order.stockist_id, 'to', p_stockist_id));
  end if;
  if p_stockist_name is distinct from v_order.stockist_name then
    v_changes := v_changes || jsonb_build_object('stockistName', jsonb_build_object('from', v_order.stockist_name, 'to', p_stockist_name));
  end if;
  if p_unit_price is distinct from v_order.unit_price then
    v_changes := v_changes || jsonb_build_object('unitPrice', jsonb_build_object('from', v_order.unit_price, 'to', p_unit_price));
  end if;

  if v_changes = '{}'::jsonb then
    raise exception 'no changes were made' using errcode = '22023';
  end if;

  v_new_total_price := coalesce(p_unit_price, 0) * p_quantity;

  update orders set
    product_id = p_product_id,
    product_name = p_product_name,
    variant = p_variant,
    quantity = p_quantity,
    unit = p_unit,
    delivery_postcode = p_delivery_postcode,
    delivery_lat = coalesce(p_delivery_lat, delivery_lat),
    delivery_lon = coalesce(p_delivery_lon, delivery_lon),
    site_id = p_site_id,
    site_name = coalesce(v_site.name, site_name),
    site_address = coalesce(v_site.address, site_address),
    site_postcode = coalesce(v_site.postcode, site_postcode),
    site_delivery_instructions = coalesce(v_site.delivery_instructions, site_delivery_instructions),
    stockist_id = p_stockist_id,
    stockist_name = p_stockist_name,
    stockist_website = p_stockist_website,
    stockist_postcode = p_stockist_postcode,
    pickup_estimate = p_pickup_estimate,
    unit_price = p_unit_price,
    total_price = v_new_total_price,
    status = v_new_status,
    approved_by_id = case when v_action = 'edit_and_reapprove' then null else approved_by_id end,
    approved_by = case when v_action = 'edit_and_reapprove' then null else approved_by end,
    approved_at = case when v_action = 'edit_and_reapprove' then null else approved_at end,
    version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'order_edited', auth.uid(), _current_display_name(), v_order.status, v_order.status, jsonb_build_object('changes', v_changes));

  if v_action = 'edit_and_reapprove' then
    insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
    values (p_order_id, v_order.community_id, 'approval_reverted', auth.uid(), _current_display_name(), 'pending_purchase', 'pending_approval');
  end if;

  return v_order;
end;
$$;

-- ============================================================ approve_order
create or replace function approve_order(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not is_owner(v_order.community_id, auth.uid()) then
    raise exception 'only an owner may approve this order' using errcode = '42501';
  end if;

  update orders set
    status = 'pending_purchase',
    approved_by_id = auth.uid(), approved_by = _current_display_name(), approved_at = now(),
    version = version + 1
  where id = p_order_id and status = 'pending_approval'
  returning * into v_order;
  if not found then raise exception 'order is no longer awaiting approval' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'approved', auth.uid(), _current_display_name(), 'pending_approval', 'pending_purchase');
  return v_order;
end;
$$;

-- ============================================================= reject_order
create or replace function reject_order(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not is_owner(v_order.community_id, auth.uid()) then
    raise exception 'only an owner may reject this order' using errcode = '42501';
  end if;

  update orders set
    status = 'rejected',
    rejected_by_id = auth.uid(), rejected_by = _current_display_name(), rejected_at = now(), rejection_reason = p_reason,
    version = version + 1
  where id = p_order_id and status = 'pending_approval'
  returning * into v_order;
  if not found then raise exception 'order is no longer awaiting approval' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, reason)
  values (p_order_id, v_order.community_id, 'rejected', auth.uid(), _current_display_name(), 'pending_approval', 'rejected', p_reason);
  return v_order;
end;
$$;

-- ========================================================== revert_approval
create or replace function revert_approval(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_decided_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not is_owner(v_order.community_id, auth.uid()) then
    raise exception 'only an owner may revert this decision' using errcode = '42501';
  end if;
  if not v_order.approval_was_required then
    raise exception 'this order never required approval' using errcode = '42501';
  end if;
  if v_order.status not in ('pending_purchase', 'rejected') then
    raise exception 'this decision can no longer be reverted' using errcode = '42501';
  end if;

  v_decided_at := case when v_order.status = 'rejected' then v_order.rejected_at else v_order.approved_at end;
  if v_decided_at is null or now() - v_decided_at > interval '72 hours' then
    raise exception 'the 72-hour revert window has passed' using errcode = '42501';
  end if;

  update orders set
    status = 'pending_approval',
    approved_by_id = null, approved_by = null, approved_at = null,
    rejected_by_id = null, rejected_by = null, rejected_at = null, rejection_reason = null,
    version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'approval_reverted', auth.uid(), _current_display_name(), v_order.status, 'pending_approval');
  return v_order;
end;
$$;

-- =========================================================== start_purchase
create or replace function start_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not can_purchase_for_site(v_order.site_id, v_order.community_id, auth.uid()) then
    raise exception 'not authorized to purchase for this site' using errcode = '42501';
  end if;

  update orders set
    status = 'purchase_in_progress',
    purchase_started_by_id = auth.uid(), purchase_started_by = _current_display_name(), purchase_started_at = now(),
    version = version + 1
  where id = p_order_id and status = 'pending_purchase'
  returning * into v_order;
  if not found then raise exception 'order is no longer waiting for purchase' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'purchase_started', auth.uid(), _current_display_name(), 'pending_purchase', 'purchase_in_progress');
  return v_order;
end;
$$;

-- ========================================================= abandon_purchase
create or replace function abandon_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.purchase_started_by_id is distinct from auth.uid() then
    raise exception 'only the buyer who started this purchase may abandon it' using errcode = '42501';
  end if;

  update orders set
    status = 'pending_purchase',
    purchase_started_by_id = null, purchase_started_by = null, purchase_started_at = null,
    version = version + 1
  where id = p_order_id and status = 'purchase_in_progress'
  returning * into v_order;
  if not found then raise exception 'no purchase is in progress for this order' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'purchase_abandoned', auth.uid(), _current_display_name(), 'purchase_in_progress', 'pending_purchase');
  return v_order;
end;
$$;

-- ========================================================= complete_purchase
create or replace function complete_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.purchase_started_by_id is distinct from auth.uid() then
    raise exception 'only the buyer who started this purchase may complete it' using errcode = '42501';
  end if;

  update orders set
    status = 'purchased',
    purchased_by_id = auth.uid(), purchased_by = _current_display_name(), purchased_at = now(),
    version = version + 1
  where id = p_order_id and status = 'purchase_in_progress'
  returning * into v_order;
  if not found then raise exception 'no purchase is in progress for this order' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'purchased', auth.uid(), _current_display_name(), 'purchase_in_progress', 'purchased');
  return v_order;
end;
$$;

-- ============================================================ claim_delivery
create or replace function claim_delivery(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not can_act_as_driver(v_order.community_id, auth.uid()) then
    raise exception 'not authorized to claim deliveries in this company' using errcode = '42501';
  end if;

  update orders set
    status = 'claimed',
    driver_id = auth.uid(), driver = _current_display_name(), claimed_at = now(),
    version = version + 1
  where id = p_order_id and status = 'purchased' and driver_id is null
  returning * into v_order;
  if not found then raise exception 'this delivery has already been claimed' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'delivery_claimed', auth.uid(), _current_display_name(), 'purchased', 'claimed');
  return v_order;
end;
$$;

-- =========================================================== cancel_delivery
create or replace function cancel_delivery(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_prev_driver_id uuid; v_prev_driver_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id is distinct from auth.uid() then
    raise exception 'only the assigned driver may cancel this claim' using errcode = '42501';
  end if;
  v_prev_driver_id := v_order.driver_id; v_prev_driver_name := v_order.driver;

  update orders set
    status = 'purchased',
    driver_id = null, driver = null, claimed_at = null,
    cancelled_by_id = auth.uid(), cancelled_by = _current_display_name(), cancelled_at = now(), cancellation_reason = p_reason,
    version = version + 1
  where id = p_order_id and status = 'claimed'
  returning * into v_order;
  if not found then raise exception 'this claim can no longer be cancelled' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, reason, meta)
  values (p_order_id, v_order.community_id, 'delivery_cancelled', auth.uid(), _current_display_name(), 'claimed', 'purchased', p_reason,
          jsonb_build_object('previousDriverId', v_prev_driver_id, 'previousDriverName', v_prev_driver_name));
  insert into order_events (order_id, community_id, type, from_status, to_status)
  values (p_order_id, v_order.community_id, 'delivery_returned_to_pool', 'purchased', 'purchased');
  return v_order;
end;
$$;

-- ============================================================ mark_collected
create or replace function mark_collected(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id is distinct from auth.uid() then
    raise exception 'only the assigned driver may mark this collected' using errcode = '42501';
  end if;

  update orders set status = 'collected', collected_at = now(), version = version + 1
  where id = p_order_id and status = 'claimed'
  returning * into v_order;
  if not found then raise exception 'this order is not currently claimed' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'collected', auth.uid(), _current_display_name(), 'claimed', 'collected');
  return v_order;
end;
$$;

-- ============================================================ mark_delivered
create or replace function mark_delivered(p_order_id uuid, p_delivery_time timestamptz, p_delivery_location text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_delivery_time is null or p_delivery_location is null or btrim(p_delivery_location) = '' then
    raise exception 'delivery time and location are required' using errcode = '23514';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id is distinct from auth.uid() then
    raise exception 'only the assigned driver may mark this delivered' using errcode = '42501';
  end if;

  update orders set
    status = 'delivered', delivered_at = now(), delivery_time = p_delivery_time, delivery_location = p_delivery_location,
    version = version + 1
  where id = p_order_id and status = 'collected'
  returning * into v_order;
  if not found then raise exception 'this order has not been collected yet' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'delivered', auth.uid(), _current_display_name(), 'collected', 'delivered',
          jsonb_build_object('deliveryTime', p_delivery_time, 'deliveryLocation', p_delivery_location));
  return v_order;
end;
$$;

-- ======================================================== cancel_order_direct
create or replace function cancel_order_direct(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id is distinct from auth.uid() then
    raise exception 'only the requester may cancel this order' using errcode = '42501';
  end if;
  if v_order.status = 'purchase_in_progress' then
    raise exception 'a purchase is currently being confirmed — try again in a moment' using errcode = '40001';
  end if;

  update orders set
    status = 'cancelled',
    order_cancelled_by_id = auth.uid(), order_cancelled_by = _current_display_name(),
    order_cancelled_at = now(), order_cancellation_reason = p_reason,
    version = version + 1
  where id = p_order_id and status in ('pending_approval', 'pending_purchase')
  returning * into v_order;
  if not found then raise exception 'this order can no longer be cancelled directly' using errcode = '42501'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, reason, meta)
  values (p_order_id, v_order.community_id, 'order_cancelled', auth.uid(), _current_display_name(), v_order.status, 'cancelled', p_reason,
          jsonb_build_object('via', 'direct'));
  return v_order;
end;
$$;

-- ====================================================== request_cancellation
create or replace function request_cancellation(p_order_id uuid, p_reason text)
returns cancellation_requests
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_request cancellation_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id is distinct from auth.uid() then
    raise exception 'only the requester may request cancellation of this order' using errcode = '42501';
  end if;
  if v_order.status not in ('purchased', 'claimed') then
    raise exception 'cancellation requests are only available after purchase, before collection' using errcode = '42501';
  end if;

  insert into cancellation_requests (order_id, community_id, site_id, requested_by_id, requested_by, reason)
  values (p_order_id, v_order.community_id, v_order.site_id, auth.uid(), _current_display_name(), p_reason)
  returning * into v_request;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, reason, meta)
  values (p_order_id, v_order.community_id, 'cancellation_requested', auth.uid(), _current_display_name(), p_reason,
          jsonb_build_object('requestId', v_request.id));
  return v_request;
end;
$$;

-- ================================================= decide_cancellation_request
create or replace function decide_cancellation_request(p_request_id uuid, p_decision cancellation_request_status, p_decision_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_request cancellation_requests%rowtype; v_order orders%rowtype; v_prev_driver_id uuid; v_prev_driver_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  select * into v_request from cancellation_requests where id = p_request_id for update;
  if not found then raise exception 'cancellation request not found' using errcode = '42704'; end if;
  if v_request.status != 'pending' then
    raise exception 'this request has already been decided' using errcode = '42501';
  end if;

  select * into v_order from orders where id = v_request.order_id for update;

  if not can_purchase_for_site(v_order.site_id, v_order.community_id, auth.uid()) then
    raise exception 'not authorized to decide this cancellation request' using errcode = '42501';
  end if;

  if p_decision = 'rejected' then
    update cancellation_requests set status = 'rejected', decided_at = now(),
      decided_by_id = auth.uid(), decided_by = _current_display_name(), decision_reason = p_decision_reason
    where id = p_request_id;

    insert into order_events (order_id, community_id, type, actor_id, actor_name, reason)
    values (v_order.id, v_order.community_id, 'cancellation_rejected', auth.uid(), _current_display_name(), p_decision_reason);
    return jsonb_build_object('ok', true, 'result', 'rejected');
  end if;

  if v_order.status not in ('purchased', 'claimed') then
    update cancellation_requests set status = 'rejected', decided_at = now(),
      decided_by_id = null, decided_by = null,
      decision_reason = 'Automatically closed — the order was collected before a decision was made.'
    where id = p_request_id;

    insert into order_events (order_id, community_id, type, reason, meta)
    values (v_order.id, v_order.community_id, 'cancellation_rejected',
            'Automatically closed — the order was collected before a decision was made.',
            jsonb_build_object('autoClosed', true));
    return jsonb_build_object('ok', false, 'autoClosed', true);
  end if;

  v_prev_driver_id := v_order.driver_id; v_prev_driver_name := v_order.driver;

  update orders set
    status = 'cancelled',
    order_cancelled_by_id = auth.uid(), order_cancelled_by = _current_display_name(),
    order_cancelled_at = now(), order_cancellation_reason = coalesce(p_decision_reason, v_request.reason),
    driver_id = null, driver = null, claimed_at = null,
    version = version + 1
  where id = v_order.id;

  update cancellation_requests set status = 'approved', decided_at = now(),
    decided_by_id = auth.uid(), decided_by = _current_display_name(), decision_reason = p_decision_reason
  where id = p_request_id;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, reason, meta)
  values (v_order.id, v_order.community_id, 'order_cancelled', auth.uid(), _current_display_name(), v_order.status, 'cancelled',
          coalesce(p_decision_reason, v_request.reason),
          jsonb_build_object('via', 'cancellation_request', 'requestId', p_request_id,
                              'previousDriverId', v_prev_driver_id, 'previousDriverName', v_prev_driver_name));
  return jsonb_build_object('ok', true, 'result', 'cancelled');
end;
$$;

-- =====================================================================
-- Explicit defense-in-depth re-assertion of grants for every protected
-- lifecycle RPC, by exact signature. CREATE OR REPLACE above does not
-- touch a function's existing ACL, so this is required in its own right —
-- it's what actually closes the edit_order gap — and doubles as the
-- permanent, explicit record of intended state that
-- tests/05_rpc_auth_hardening.sql checks against on every test run.
-- =====================================================================
revoke execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric),
  edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric),
  approve_order(uuid),
  reject_order(uuid, text),
  revert_approval(uuid),
  start_purchase(uuid),
  abandon_purchase(uuid),
  complete_purchase(uuid),
  claim_delivery(uuid),
  cancel_delivery(uuid, text),
  mark_collected(uuid),
  mark_delivered(uuid, timestamptz, text),
  cancel_order_direct(uuid, text),
  request_cancellation(uuid, text),
  decide_cancellation_request(uuid, cancellation_request_status, text)
from public, anon;

grant execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric),
  edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric),
  approve_order(uuid),
  reject_order(uuid, text),
  revert_approval(uuid),
  start_purchase(uuid),
  abandon_purchase(uuid),
  complete_purchase(uuid),
  claim_delivery(uuid),
  cancel_delivery(uuid, text),
  mark_collected(uuid),
  mark_delivered(uuid, timestamptz, text),
  cancel_order_direct(uuid, text),
  request_cancellation(uuid, text),
  decide_cancellation_request(uuid, cancellation_request_status, text)
to authenticated;
