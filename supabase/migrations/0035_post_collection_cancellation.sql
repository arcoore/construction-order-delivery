-- Post-collection cancellation (product-audit gap fix).
--
-- Before: a worker could request cancellation only at 'purchased' / 'claimed';
-- once a driver marked the order 'collected' the request path was closed and
-- any still-pending request auto-closed. But goods sometimes need to be sent
-- back after collection — the worker had no in-app way to start that.
--
-- After: cancellation can also be requested at 'collected'. If the buyer
-- approves a collected order's cancellation, the order still moves to
-- 'cancelled', and the DRIVER (who physically has the goods) is notified to
-- arrange the return with the supplier directly — SiteStock doesn't manage
-- that leg, it just makes sure the driver knows to stop. Delivered orders
-- stay non-cancellable (the goods are already on site).
--
-- Two CREATE OR REPLACE of existing functions, same signatures (ACL
-- preserved): request_cancellation widens its allowed statuses;
-- decide_cancellation_request widens its "still actionable" check and adds
-- the driver notification on the approved branch.

-- ================================================================
-- request_cancellation — allow 'collected' too.
-- ================================================================
create or replace function request_cancellation(p_order_id uuid, p_reason text)
returns cancellation_requests
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_request cancellation_requests%rowtype; v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.requested_by_id is distinct from auth.uid() then
    raise exception 'only the requester may request cancellation of this order' using errcode = '42501';
  end if;
  if v_order.status not in ('purchased', 'claimed', 'collected') then
    raise exception 'cancellation requests are only available after purchase, before delivery' using errcode = '42501';
  end if;

  insert into cancellation_requests (order_id, community_id, site_id, requested_by_id, requested_by, reason)
  values (p_order_id, v_order.community_id, v_order.site_id, auth.uid(), _current_display_name(), p_reason)
  returning * into v_request;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, reason, meta)
  values (p_order_id, v_order.community_id, 'cancellation_requested', auth.uid(), _current_display_name(), p_reason,
          jsonb_build_object('requestId', v_request.id));

  if v_order.purchased_by_id is not null then
    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A worker');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, request_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.purchased_by_id, 'cancellation_requested', 'orderUpdates', 'Cancellation requested',
      format('%s requested to cancel %s for %s%s: %s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'),
             case when v_order.status = 'collected' then ' (already collected by the driver)' else '' end, p_reason),
      v_order.community_id, v_order.id, v_request.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'cancellation_requested');
  end if;

  return v_request;
end;
$$;

-- ================================================================
-- decide_cancellation_request — 'collected' is now actionable; notify the
-- driver on the approved branch so they know to arrange the return.
-- ================================================================
create or replace function decide_cancellation_request(p_request_id uuid, p_decision cancellation_request_status, p_decision_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_request cancellation_requests%rowtype; v_order orders%rowtype;
  v_prev_driver_id uuid; v_prev_driver_name text; v_actor_name text; v_was_collected boolean;
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

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The buyer');

  if p_decision = 'rejected' then
    update cancellation_requests set status = 'rejected', decided_at = now(),
      decided_by_id = auth.uid(), decided_by = _current_display_name(), decision_reason = p_decision_reason
    where id = p_request_id;

    insert into order_events (order_id, community_id, type, actor_id, actor_name, reason)
    values (v_order.id, v_order.community_id, 'cancellation_rejected', auth.uid(), _current_display_name(), p_decision_reason);

    if v_request.requested_by_id is not null then
      insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, request_id, site_id, actor_id, actor_name, navigation_target)
      select v_request.requested_by_id, 'cancellation_rejected', 'orderUpdates', 'Cancellation request rejected',
        format('%s rejected your cancellation request for %s for %s%s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), case when p_decision_reason is not null and btrim(p_decision_reason) <> '' then ': ' || p_decision_reason else '.' end),
        v_order.community_id, v_order.id, p_request_id, v_order.site_id, auth.uid(), v_actor_name,
        jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
      where v_request.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_request.requested_by_id, 'cancellation_rejected');
    end if;

    return jsonb_build_object('ok', true, 'result', 'rejected');
  end if;

  -- approved: 'delivered' (and anything terminal) is no longer actionable —
  -- auto-close, no notification (matches the historical behaviour for the
  -- old 'collected' cutoff).
  if v_order.status not in ('purchased', 'claimed', 'collected') then
    update cancellation_requests set status = 'rejected', decided_at = now(),
      decided_by_id = null, decided_by = null,
      decision_reason = 'Automatically closed — the order was delivered before a decision was made.'
    where id = p_request_id;

    insert into order_events (order_id, community_id, type, reason, meta)
    values (v_order.id, v_order.community_id, 'cancellation_rejected',
            'Automatically closed — the order was delivered before a decision was made.',
            jsonb_build_object('autoClosed', true));
    return jsonb_build_object('ok', false, 'autoClosed', true);
  end if;

  v_was_collected := v_order.status = 'collected';
  v_prev_driver_id := v_order.driver_id; v_prev_driver_name := v_order.driver;

  update orders set
    status = 'cancelled',
    order_cancelled_by_id = auth.uid(), order_cancelled_by = _current_display_name(),
    order_cancelled_at = now(), order_cancellation_reason = coalesce(p_decision_reason, v_request.reason),
    driver_id = null, driver = null, claimed_at = null, collected_at = null,
    version = version + 1
  where id = v_order.id;

  update cancellation_requests set status = 'approved', decided_at = now(),
    decided_by_id = auth.uid(), decided_by = _current_display_name(), decision_reason = p_decision_reason
  where id = p_request_id;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, reason, meta)
  values (v_order.id, v_order.community_id, 'order_cancelled', auth.uid(), _current_display_name(), v_order.status, 'cancelled',
          coalesce(p_decision_reason, v_request.reason),
          jsonb_build_object('via', 'cancellation_request', 'requestId', p_request_id,
                              'previousDriverId', v_prev_driver_id, 'previousDriverName', v_prev_driver_name,
                              'wasCollected', v_was_collected));

  if v_request.requested_by_id is not null then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, request_id, site_id, actor_id, actor_name, navigation_target)
    select v_request.requested_by_id, 'cancellation_approved', 'orderUpdates', 'Cancellation approved',
      format('%s approved your cancellation request for %s for %s.%s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'),
             case when v_was_collected then ' The driver has been asked to arrange the return with the supplier.' else '' end),
      v_order.community_id, v_order.id, p_request_id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_request.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_request.requested_by_id, 'cancellation_approved');
  end if;

  -- The driver (if there was one) needs to know — especially after
  -- collection, when they physically hold the goods.
  if v_prev_driver_id is not null and v_prev_driver_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, request_id, site_id, actor_id, actor_name, navigation_target)
    select v_prev_driver_id, 'cancellation_approved', 'orderUpdates', 'Delivery cancelled',
      format('%s for %s was cancelled%s.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'),
             case when v_was_collected then ' after you collected it — please arrange the return with the supplier directly' else ' — you no longer need to deliver it' end),
      v_order.community_id, v_order.id, p_request_id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'driver', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where notification_type_enabled_for(v_prev_driver_id, 'cancellation_approved');
  end if;

  return jsonb_build_object('ok', true, 'result', 'cancelled');
end;
$$;
