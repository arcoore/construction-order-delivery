-- Order delivery method — closes a real gap the product audit surfaced:
-- every order previously assumed the company's own Driver pool always
-- collects and delivers, even though real UK builders' merchants very often
-- deliver straight to site. This adds a second path alongside the existing
-- one; it does not touch or weaken the existing driver claim/collect/deliver
-- flow, which remains the default and only changes if a Worker explicitly
-- picks the other option at creation time.
--
-- delivery_method is set once at creation and is NOT in EDITABLE_ORDER_FIELDS
-- (public/js/orderLifecycle.js) — deliberately not editable afterward, same
-- "don't let a change quietly invalidate what's already in flight" caution
-- this project already applies to siteId/quantity/material edits, without
-- needing a re-approval interaction for a field this one is simpler to just
-- lock at creation instead.

alter table orders
  add column delivery_method text not null default 'driver'
    check (delivery_method in ('driver', 'direct_supplier'));

-- =====================================================================
-- create_order: widen from 0019's 18-arg signature to add p_delivery_method.
-- Same drop-then-recreate-then-re-grant discipline 0012/0013/0019 already
-- established — the old signature is explicitly dropped, never left as a
-- second reachable overload.
-- =====================================================================
drop function if exists create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz);

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
  p_unit_price numeric,
  p_needed_by_type text,
  p_needed_by timestamptz,
  p_delivery_method text default 'driver'
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_site sites%rowtype;
  v_community communities%rowtype;
  v_status order_status;
  v_approval_required boolean;
  v_order orders%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not can_create_order_for_site(p_site_id, p_community_id, auth.uid()) then
    raise exception 'not authorized to order for this site' using errcode = '42501';
  end if;

  if p_needed_by_type = 'deadline' and p_needed_by <= now() then
    raise exception 'needed_by must be in the future' using errcode = '22023';
  end if;

  if p_delivery_method not in ('driver', 'direct_supplier') then
    raise exception 'invalid delivery method' using errcode = '22023';
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
    unit_price, total_price,
    needed_by_type, needed_by, delivery_method
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    p_product_id, p_product_name, p_variant, p_quantity, p_unit,
    p_delivery_postcode, p_delivery_lat, p_delivery_lon,
    auth.uid(), _current_display_name(), v_status, v_approval_required,
    p_stockist_id, p_stockist_name, p_stockist_website, p_stockist_postcode, p_pickup_estimate,
    p_unit_price, p_unit_price * p_quantity,
    p_needed_by_type, p_needed_by, p_delivery_method
  ) returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (v_order.id, p_community_id, 'order_created', auth.uid(), _current_display_name(), null, v_status);

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A worker');

  if v_approval_required then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_awaiting_approval', 'approvalUpdates', 'New order needs approval',
      format('%s requested %s for %s.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'owner', 'orderId', v_order.id, 'siteId', v_order.site_id)
    from (
      select owner_id as uid from communities where id = v_order.community_id
      union select user_id from owner_grants where community_id = v_order.community_id
    ) owners
    where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_awaiting_approval');
  else
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_ready_for_purchase', 'orderUpdates', 'Order ready to purchase',
      format('%s for %s — %s — is ready to purchase.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), _format_price(v_order.total_price)),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    from (select user_id as uid from buyer_grants where community_id = v_order.community_id) buyers
    where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_ready_for_purchase');
  end if;

  return v_order;
end;
$$;

revoke execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz, text)
from public, anon;

grant execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz, text)
to authenticated;

-- =====================================================================
-- claim_delivery: redefined (same single-uuid signature as 0014, no
-- drop/re-grant needed) purely to add a delivery_method guard — a
-- direct_supplier order must never enter the driver pool at all. Everything
-- else here is byte-identical to 0014's version.
-- =====================================================================
create or replace function claim_delivery(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if not can_act_as_driver(v_order.community_id, auth.uid()) then
    raise exception 'not authorized to claim deliveries in this company' using errcode = '42501';
  end if;
  if v_order.delivery_method = 'direct_supplier' then
    raise exception 'this order is set for direct supplier delivery and has no driver leg to claim' using errcode = '22023';
  end if;

  update orders set
    status = 'claimed',
    driver_id = auth.uid(), driver = _current_display_name(), claimed_at = now(),
    version = version + 1
  where id = p_order_id and status = 'purchased' and driver_id is null and delivery_method = 'driver'
  returning * into v_order;
  if not found then raise exception 'this delivery has already been claimed' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'delivery_claimed', auth.uid(), _current_display_name(), 'purchased', 'claimed');

  if v_order.purchased_by_id is not null then
    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A driver');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.purchased_by_id, 'delivery_claimed', 'deliveryUpdates', 'Driver assigned to your order',
      format('%s claimed %s for %s for delivery.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'delivery_claimed');
  end if;

  return v_order;
end;
$$;

-- =====================================================================
-- confirm_direct_delivery: the direct-supplier-delivery counterpart to
-- mark_delivered. Only reachable when the order's own delivery_method says
-- so (checked both defensively in the WHERE clause and explicitly, so it
-- fails with a clear message rather than a generic "not found" if someone
-- calls it on an ordinary driver-delivery order). Only the buyer who
-- purchased it may confirm — mirrors mark_delivered's "only the assigned
-- driver" rule exactly, just for the other delivery method. Skips
-- claimed/collected entirely: purchased -> delivered directly, since there
-- is no SiteStock driver leg for this path at all.
-- =====================================================================
create or replace function confirm_direct_delivery(p_order_id uuid, p_delivery_time timestamptz, p_delivery_location text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text; v_message text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_delivery_time is null or p_delivery_location is null or btrim(p_delivery_location) = '' then
    raise exception 'delivery time and location are required' using errcode = '23514';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.delivery_method is distinct from 'direct_supplier' then
    raise exception 'this order is not set up for direct supplier delivery' using errcode = '22023';
  end if;
  if v_order.purchased_by_id is distinct from auth.uid() then
    raise exception 'only the buyer who purchased this order may confirm delivery' using errcode = '42501';
  end if;

  update orders set
    status = 'delivered', delivered_at = now(), delivery_time = p_delivery_time, delivery_location = p_delivery_location,
    version = version + 1
  where id = p_order_id and status = 'purchased' and delivery_method = 'direct_supplier'
  returning * into v_order;
  if not found then raise exception 'this order is not currently awaiting direct delivery' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'delivered', auth.uid(), _current_display_name(), 'purchased', 'delivered',
          jsonb_build_object('deliveryTime', p_delivery_time, 'deliveryLocation', p_delivery_location, 'viaDirectSupplier', true));

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The buyer');
  v_message := format('%s for %s was delivered to %s.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), v_order.delivery_location);

  if v_order.requested_by_id is not null then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.requested_by_id, 'order_delivered', 'deliveryUpdates', 'Order delivered', v_message,
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.requested_by_id, 'order_delivered');
  end if;

  return v_order;
end;
$$;

revoke execute on function confirm_direct_delivery(uuid, timestamptz, text) from public, anon;
grant execute on function confirm_direct_delivery(uuid, timestamptz, text) to authenticated;
