-- Multi-item orders (product-audit gap fix — the biggest single change).
--
-- Before: one order = one product line (orders.product_id/product_name/
-- variant/quantity/unit/unit_price). A worker needing three materials had
-- to submit three separate requests.
--
-- After: one order -> many order_items -> still ONE supplier, ONE delivery,
-- ONE status. The order state machine and every lifecycle RPC's LOGIC are
-- completely unchanged — only "what's in the order" moves from columns on
-- `orders` to rows in `order_items`. Partial fulfilment, per-item status,
-- and multi-supplier-per-order are all deliberately still out of scope.
--
-- Design choices that keep the blast radius small:
--   * orders.product_name / orders.variant are KEPT as a denormalised
--     "headline" (the first item, plus " + N more" when there are several),
--     maintained by create_order / edit_order. Every lifecycle RPC
--     (approve_order, reject_order, complete_purchase, claim_delivery,
--     mark_delivered, the cancellation RPCs, ...) references only
--     _order_label(v_order.product_name, v_order.variant) for its
--     notification text — so NONE of them need to change. A multi-item
--     order's notifications name the headline item and link to the order,
--     where every item is visible. Accepted minor limitation.
--   * orders.total_price is KEPT, now maintained as the SUM of every item's
--     line_total. Every existing read of order.total_price still works.
--   * orders.product_id / quantity / unit / unit_price are DROPPED — they
--     are genuinely per-item and keeping a misleading "first item" copy of
--     them on the order row would invite bugs (e.g. quantity * unit_price
--     != total_price). order_items is their single source of truth.
--   * order_items is NOT added to the realtime publication — it rides the
--     existing `orders` change signal exactly like order_events already
--     does (orderLifecycle.js's refreshOrderCache refetches all of them
--     together). Migration 0016 is untouched.
--
-- create_order / edit_order swap their five per-item parameters for a
-- single p_items jsonb array, following the same drop-then-recreate-then-
-- re-grant discipline every prior widening used.

-- ================================================================
-- 1. order_items — the line-item source of truth.
-- ================================================================
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  -- denormalised from the parent order purely for RLS/query convenience,
  -- exactly like order_events.community_id.
  community_id uuid not null,
  product_id text not null,
  product_name text not null,
  variant text,
  quantity numeric not null check (quantity > 0),
  unit text not null,
  unit_price numeric check (unit_price is null or unit_price >= 0),
  -- always server-computed as coalesce(unit_price,0) * quantity — never
  -- client-set, same rule orders.total_price has always followed.
  line_total numeric not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index order_items_order_idx on order_items (order_id);

-- ================================================================
-- 2. RLS — mirrors order_events exactly: visible iff you can see the parent
--    order; no write grant at all (RPC-only, SECURITY DEFINER bypasses RLS).
-- ================================================================
alter table order_items enable row level security;
grant select on order_items to authenticated;

create policy order_items_select on order_items
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and (
          is_owner(o.community_id, auth.uid())
          or o.requested_by_id = auth.uid()
          or o.driver_id = auth.uid()
          or can_access_site(o.site_id, o.community_id, auth.uid())
          or can_purchase_for_site(o.site_id, o.community_id, auth.uid())
        )
    )
  );

-- ================================================================
-- 3. Backfill — one item per existing order, then drop the per-item columns.
-- ================================================================
insert into order_items (order_id, community_id, product_id, product_name, variant, quantity, unit, unit_price, line_total, sort_order)
select id, community_id, product_id, product_name, variant, quantity, unit, unit_price,
       coalesce(unit_price, 0) * quantity, 0
from orders;

alter table orders drop constraint if exists orders_unit_price_nonnegative;
alter table orders drop column product_id;
alter table orders drop column quantity;
alter table orders drop column unit;
alter table orders drop column unit_price;
-- product_name, variant, total_price all deliberately kept.

-- ================================================================
-- 4. Helpers for the denormalised headline.
-- ================================================================
create or replace function _items_headline_name(p_items jsonb)
returns text language sql immutable set search_path = public as $$
  select (p_items->0->>'productName')
    || case when jsonb_array_length(p_items) > 1
       then ' + ' || (jsonb_array_length(p_items) - 1)::text || ' more'
       else '' end;
$$;

create or replace function _items_headline_variant(p_items jsonb)
returns text language sql immutable set search_path = public as $$
  select case when jsonb_array_length(p_items) > 1
    then null
    else nullif(p_items->0->>'variant', '') end;
$$;

create or replace function _items_total(p_items jsonb)
returns numeric language sql immutable set search_path = public as $$
  select coalesce(sum(
    coalesce((elem->>'unitPrice')::numeric, 0) * (elem->>'quantity')::numeric
  ), 0)
  from jsonb_array_elements(p_items) elem;
$$;

-- Raises 22023 if p_items isn't a non-empty array of well-formed items.
create or replace function _validate_items(p_items jsonb)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order needs at least one item' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) elem
    where coalesce(elem->>'productId', '') = ''
       or coalesce(elem->>'productName', '') = ''
       or coalesce(elem->>'unit', '') = ''
       or (elem->>'quantity') is null
       or (elem->>'quantity')::numeric <= 0
       or ((elem->>'unitPrice') is not null and (elem->>'unitPrice')::numeric < 0)
  ) then
    raise exception 'every item needs a product, a unit, and a quantity greater than zero' using errcode = '22023';
  end if;
end;
$$;

-- Inserts every element of p_items as an order_items row for p_order_id.
create or replace function _insert_order_items(p_order_id uuid, p_community_id uuid, p_items jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into order_items (order_id, community_id, product_id, product_name, variant, quantity, unit, unit_price, line_total, sort_order)
  select p_order_id, p_community_id,
    elem->>'productId', elem->>'productName', nullif(elem->>'variant', ''),
    (elem->>'quantity')::numeric, elem->>'unit',
    (elem->>'unitPrice')::numeric,
    coalesce((elem->>'unitPrice')::numeric, 0) * (elem->>'quantity')::numeric,
    (ord - 1)::integer
  from jsonb_array_elements(p_items) with ordinality as t(elem, ord);
end;
$$;

-- ================================================================
-- 5. create_order — p_items jsonb replaces the five per-item params.
-- ================================================================
drop function if exists create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz, text);

create or replace function create_order(
  p_community_id uuid,
  p_site_id uuid,
  p_items jsonb,
  p_delivery_postcode text,
  p_delivery_lat double precision,
  p_delivery_lon double precision,
  p_stockist_id text,
  p_stockist_name text,
  p_stockist_website text,
  p_stockist_postcode text,
  p_pickup_estimate text,
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

  perform _validate_items(p_items);

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
    product_name, variant,
    delivery_postcode, delivery_lat, delivery_lon,
    requested_by_id, requested_by, status, approval_was_required,
    stockist_id, stockist_name, stockist_website, stockist_postcode, pickup_estimate,
    total_price,
    needed_by_type, needed_by, delivery_method
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    _items_headline_name(p_items), _items_headline_variant(p_items),
    p_delivery_postcode, p_delivery_lat, p_delivery_lon,
    auth.uid(), _current_display_name(), v_status, v_approval_required,
    p_stockist_id, p_stockist_name, p_stockist_website, p_stockist_postcode, p_pickup_estimate,
    _items_total(p_items),
    p_needed_by_type, p_needed_by, p_delivery_method
  ) returning * into v_order;

  perform _insert_order_items(v_order.id, p_community_id, p_items);

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

-- ================================================================
-- 6. edit_order — p_items jsonb replaces the five per-item params. Item
--    changes are recorded coarsely in meta.changes.items ({from:[...], to:
--    [...]} of {productName,variant,quantity,unit,unitPrice}); every
--    non-item field keeps its exact field-level diff. Any item change
--    counts toward "something changed" and toward forcing re-approval, the
--    same as a quantity change did before.
-- ================================================================
drop function if exists edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz);

create or replace function edit_order(
  p_order_id uuid,
  p_expected_version integer,
  p_items jsonb,
  p_delivery_postcode text,
  p_delivery_lat double precision,
  p_delivery_lon double precision,
  p_site_id uuid,
  p_stockist_id text,
  p_stockist_name text,
  p_stockist_website text,
  p_stockist_postcode text,
  p_pickup_estimate text,
  p_needed_by_type text,
  p_needed_by timestamptz
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_site sites%rowtype;
  v_action text;
  v_new_status order_status;
  v_changes jsonb := '{}'::jsonb;
  v_actor_name text;
  v_old_items jsonb;
  v_items_changed boolean := false;
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

  perform _validate_items(p_items);

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

  -- Coarse item diff: normalise both sides to arrays of the fields that
  -- matter and compare as jsonb.
  select coalesce(jsonb_agg(jsonb_build_object(
           'productName', product_name, 'variant', variant,
           'quantity', quantity, 'unit', unit, 'unitPrice', unit_price
         ) order by sort_order), '[]'::jsonb)
    into v_old_items
    from order_items where order_id = p_order_id;

  if (
    select coalesce(jsonb_agg(jsonb_build_object(
             'productName', elem->>'productName', 'variant', nullif(elem->>'variant',''),
             'quantity', (elem->>'quantity')::numeric, 'unit', elem->>'unit',
             'unitPrice', (elem->>'unitPrice')::numeric
           )), '[]'::jsonb)
    from jsonb_array_elements(p_items) elem
  ) is distinct from v_old_items then
    v_items_changed := true;
    v_changes := v_changes || jsonb_build_object('items', jsonb_build_object('from', v_old_items, 'to', p_items));
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

  if p_needed_by_type is distinct from v_order.needed_by_type or p_needed_by is distinct from v_order.needed_by then
    if p_needed_by_type = 'deadline' and p_needed_by <= now() then
      raise exception 'needed_by must be in the future' using errcode = '22023';
    end if;
    v_changes := v_changes || jsonb_build_object('neededByType', jsonb_build_object('from', v_order.needed_by_type, 'to', p_needed_by_type));
  end if;

  if v_changes = '{}'::jsonb then
    raise exception 'no changes were made' using errcode = '22023';
  end if;

  update orders set
    product_name = _items_headline_name(p_items),
    variant = _items_headline_variant(p_items),
    total_price = _items_total(p_items),
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
    needed_by_type = p_needed_by_type,
    needed_by = p_needed_by,
    status = v_new_status,
    approved_by_id = case when v_action = 'edit_and_reapprove' then null else approved_by_id end,
    approved_by = case when v_action = 'edit_and_reapprove' then null else approved_by end,
    approved_at = case when v_action = 'edit_and_reapprove' then null else approved_at end,
    version = version + 1
  where id = p_order_id
  returning * into v_order;

  if v_items_changed then
    delete from order_items where order_id = p_order_id;
    perform _insert_order_items(p_order_id, v_order.community_id, p_items);
  end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'order_edited', auth.uid(), _current_display_name(), v_order.status, v_order.status, jsonb_build_object('changes', v_changes));

  if v_action = 'edit_and_reapprove' then
    insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
    values (p_order_id, v_order.community_id, 'approval_reverted', auth.uid(), _current_display_name(), 'pending_purchase', 'pending_approval');

    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A worker');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_awaiting_approval', 'approvalUpdates', 'New order needs approval',
      format('%s edited %s for %s — it needs approval again.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'owner', 'orderId', v_order.id, 'siteId', v_order.site_id)
    from (
      select owner_id as uid from communities where id = v_order.community_id
      union select user_id from owner_grants where community_id = v_order.community_id
    ) owners
    where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_awaiting_approval');
  end if;

  return v_order;
end;
$$;

-- ================================================================
-- 7. Re-grant, exact new signatures (CREATE OR REPLACE drops the ACL when
--    the signature changes).
-- ================================================================
revoke execute on function
  create_order(uuid, uuid, jsonb, text, double precision, double precision, text, text, text, text, text, text, timestamptz, text),
  edit_order(uuid, integer, jsonb, text, double precision, double precision, uuid, text, text, text, text, text, text, timestamptz)
from public, anon;

grant execute on function
  create_order(uuid, uuid, jsonb, text, double precision, double precision, text, text, text, text, text, text, timestamptz, text),
  edit_order(uuid, integer, jsonb, text, double precision, double precision, uuid, text, text, text, text, text, text, timestamptz)
to authenticated;
