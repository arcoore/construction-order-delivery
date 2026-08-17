-- Phase 8C — widens edit_order to cover the Worker edit feature's actual
-- field set (verified against public/js/site.js's real edit UI, not
-- guessed), and adds an explicit non-negative guard on unit_price.
--
-- PRICING TRUST BOUNDARY (documented here deliberately, not glossed over):
-- there is no server-side product/stockist catalogue in this schema —
-- product/variant/stockist identity and unit_price all originate from the
-- browser's client-side mock catalog (public/js/data.js), exactly as
-- create_order (0010) already accepts them. The server cannot independently
-- prove a browser-supplied unit_price is the real supplier price — that
-- would require a real catalogue/supplier integration, explicitly out of
-- scope for Phase 8C. What the server DOES enforce: unit_price must be a
-- sensible non-negative number (see the check constraint below), and
-- total_price is ALWAYS server-computed as unit_price * quantity — the
-- browser can never set total_price directly, on create or on edit. This is
-- a temporary commercial-data trust limitation, not a security gap: it
-- doesn't weaken authorization, tenancy, lifecycle transitions, event
-- integrity, or concurrency control, all of which remain fully
-- server-enforced exactly as before.

-- Defense-in-depth at the table level — protects every current and future
-- writer of this column (create_order's INSERT and edit_order's UPDATE
-- alike), matching the existing quantity > 0 constraint's pattern in
-- 0005_orders_and_events.sql rather than duplicating a numeric check inside
-- each function body.
alter table orders add constraint orders_unit_price_nonnegative
  check (unit_price is null or unit_price >= 0);

-- The old 5-parameter edit_order is a DIFFERENT signature from the widened
-- one below — Postgres would otherwise keep both as overloaded functions
-- rather than replacing it, which would break `supabase.rpc('edit_order', ...)`
-- callers with an ambiguous-function error. Drop it explicitly first.
drop function if exists edit_order(uuid, integer, numeric, uuid, text);

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
  p_site_id uuid,       -- pass the existing site_id if unchanged
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
    v_changes := v_changes || jsonb_build_object('siteId', jsonb_build_object('from', v_order.site_id, 'to', p_site_id));
    v_changes := v_changes || jsonb_build_object('siteName', jsonb_build_object('from', v_order.site_name, 'to', v_site.name));
    v_changes := v_changes || jsonb_build_object('siteAddress', jsonb_build_object('from', v_order.site_address, 'to', v_site.address));
    v_changes := v_changes || jsonb_build_object('sitePostcode', jsonb_build_object('from', v_order.site_postcode, 'to', v_site.postcode));
    v_changes := v_changes || jsonb_build_object('siteDeliveryInstructions', jsonb_build_object('from', v_order.site_delivery_instructions, 'to', v_site.delivery_instructions));
  end if;

  -- Only fields that actually changed go into meta.changes, matching the
  -- prototype's editOrder() diff behavior exactly — a no-op resubmit of an
  -- unchanged field is never recorded as a change.
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

  -- total_price is NEVER accepted from the caller — always recomputed here
  -- from the (server-validated, see the unit_price check constraint)
  -- unit_price and the new quantity. See this file's header for the
  -- pricing trust boundary this reflects.
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

grant execute on function
  edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric)
to authenticated;
