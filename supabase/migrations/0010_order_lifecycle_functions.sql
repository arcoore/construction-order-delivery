-- Order-lifecycle RPC functions — the server-side replacement for
-- orderLifecycle.js's guarded entry points. Every function:
--   1. derives the actor from auth.uid(), never a parameter
--   2. locks the current row (SELECT ... FOR UPDATE) before validating
--   3. re-checks permission at call time via the 0008 helper functions
--   4. validates the requested transition against the row's CURRENT status
--   5. mutates state and appends the audit event in the same transaction
--   6. raises an exception (rolling back everything) on any failure
--
-- Status-transition races between two legitimate concurrent actors are
-- resolved by conditional UPDATE ... WHERE status = $expected combined with
-- the row lock: Postgres serializes the two attempts, the loser's UPDATE
-- either sees the row already locked (waits, then re-evaluates the WHERE
-- against the now-changed row and affects 0 rows) or the SELECT ... FOR
-- UPDATE itself blocks until the winner's transaction commits. Either way,
-- exactly one attempt can ever succeed.

create or replace function _current_display_name()
returns text
language sql stable security definer set search_path = public as $$
  select display_name from profiles where id = auth.uid();
$$;

-- ------------------------------------------------------------- create_order
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

-- --------------------------------------------------------------- edit_order
-- EDITABLE_ORDER_FIELDS equivalent: only quantity/variant/site/postcode are
-- ever accepted here — requested_by/created_at/status/every actor field are
-- structurally impossible to smuggle through this signature at all, which
-- is a strictly stronger guarantee than orderLifecycle.js's whitelist check.
create or replace function edit_order(
  p_order_id uuid,
  p_expected_version integer,
  p_quantity numeric,
  p_site_id uuid,       -- pass the existing site_id if unchanged
  p_delivery_postcode text
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_site sites%rowtype;
  v_action text;
  v_new_status order_status;
  v_changes jsonb := '{}'::jsonb;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id != auth.uid() then
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
    v_changes := v_changes || jsonb_build_object('site', jsonb_build_object('from', v_order.site_name, 'to', v_site.name));
  end if;

  if p_quantity != v_order.quantity then
    v_changes := v_changes || jsonb_build_object('quantity', jsonb_build_object('from', v_order.quantity, 'to', p_quantity));
  end if;

  update orders set
    quantity = p_quantity,
    total_price = coalesce(unit_price, 0) * p_quantity,
    delivery_postcode = p_delivery_postcode,
    site_id = p_site_id,
    site_name = coalesce(v_site.name, site_name),
    site_address = coalesce(v_site.address, site_address),
    site_postcode = coalesce(v_site.postcode, site_postcode),
    site_delivery_instructions = coalesce(v_site.delivery_instructions, site_delivery_instructions),
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

-- ------------------------------------------------------------- approve_order
create or replace function approve_order(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
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

-- -------------------------------------------------------------- reject_order
create or replace function reject_order(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
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

-- ----------------------------------------------------------- revert_approval
-- 72-hour window matches orderLifecycle.js's REVERT_WINDOW_MS.
create or replace function revert_approval(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_decided_at timestamptz;
begin
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

-- -------------------------------------------------------------- start_purchase
create or replace function start_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
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

-- ------------------------------------------------------------- abandon_purchase
create or replace function abandon_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.purchase_started_by_id != auth.uid() then
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

-- ------------------------------------------------------------- complete_purchase
create or replace function complete_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.purchase_started_by_id != auth.uid() then
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

-- -------------------------------------------------------------- claim_delivery
-- The conditional UPDATE's "and driver_id is null" is what makes the
-- two-drivers race safe: only the first commit can ever match that
-- condition, the second affects zero rows and is told it's already claimed.
create or replace function claim_delivery(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
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

-- -------------------------------------------------------------- cancel_delivery
create or replace function cancel_delivery(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_prev_driver_id uuid; v_prev_driver_name text;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id != auth.uid() then
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

-- ---------------------------------------------------------------- mark_collected
create or replace function mark_collected(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id != auth.uid() then
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

-- ---------------------------------------------------------------- mark_delivered
create or replace function mark_delivered(p_order_id uuid, p_delivery_time timestamptz, p_delivery_location text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  if p_delivery_time is null or p_delivery_location is null or btrim(p_delivery_location) = '' then
    raise exception 'delivery time and location are required' using errcode = '23514';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id != auth.uid() then
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

-- ----------------------------------------------------------- cancel_order_direct
create or replace function cancel_order_direct(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id != auth.uid() then
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

-- ------------------------------------------------------------ request_cancellation
-- order.status is deliberately never touched here — a Driver can still
-- claim/collect normally while a request sits pending, exactly matching the
-- prototype's Phase 7B design.
create or replace function request_cancellation(p_order_id uuid, p_reason text)
returns cancellation_requests
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_request cancellation_requests%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id != auth.uid() then
    raise exception 'only the requester may request cancellation of this order' using errcode = '42501';
  end if;
  if v_order.status not in ('purchased', 'claimed') then
    raise exception 'cancellation requests are only available after purchase, before collection' using errcode = '42501';
  end if;

  insert into cancellation_requests (order_id, community_id, site_id, requested_by_id, requested_by, reason)
  values (p_order_id, v_order.community_id, v_order.site_id, auth.uid(), _current_display_name(), p_reason)
  returning * into v_request; -- the partial unique index in 0006 rejects a second concurrent pending request

  insert into order_events (order_id, community_id, type, actor_id, actor_name, reason, meta)
  values (p_order_id, v_order.community_id, 'cancellation_requested', auth.uid(), _current_display_name(), p_reason,
          jsonb_build_object('requestId', v_request.id));
  return v_request;
end;
$$;

-- ------------------------------------------------------- decide_cancellation_request
-- Returns jsonb rather than raising on the collected-before-decision race,
-- because that outcome is a normal, anticipated result (per Phase 7B's own
-- design), not a caller error — the request is deterministically auto-
-- closed as rejected and the order is left exactly as it was, never
-- falsely cancelled out from under a physically-collected delivery.
create or replace function decide_cancellation_request(p_request_id uuid, p_decision cancellation_request_status, p_decision_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_request cancellation_requests%rowtype; v_order orders%rowtype; v_prev_driver_id uuid; v_prev_driver_name text;
begin
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

  -- p_decision = 'approved': the underlying cancel_order transition has no
  -- edge at 'collected' or beyond — if the order has already moved past
  -- 'purchased'/'claimed', this table itself refuses the transition, not a
  -- hand-written status check.
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
