-- Snapshot the site's contact + access info onto each order (product-audit
-- gap fix — finishes migration 0027).
--
-- 0027 gave sites a contact name, contact phone, and access notes, and the
-- owner-facing Sites screen manages them. But the person those fields exist
-- for — the driver collecting and delivering — never saw them: an order
-- only ever snapshotted site_name / site_address / site_postcode /
-- site_delivery_instructions, and a driver's cache never even contains the
-- live `sites` row (RLS only shows a non-owner sites they're a member of).
--
-- Fix: three more point-in-time snapshot columns on `orders`, populated the
-- exact same way and at the exact same points as the four that already
-- exist — set from the site in create_order, re-set from the new site in
-- edit_order when the order is moved, and never touched by a later edit to
-- the live site record (renaming/editing a site never rewrites history —
-- CLAUDE.md's Site model rule).
--
-- No RPC signature changes at all — create_order / edit_order keep the exact
-- 14-arg signatures migration 0030 gave them, so this is a plain
-- CREATE OR REPLACE (which preserves the existing ACL) with no
-- drop/re-grant, and the tests.create_order_1 / tests.edit_order_1 wrappers
-- in 00_helpers.sql are unaffected.

-- ================================================================
-- 1. Columns + backfill from the current site record.
-- ================================================================
alter table orders add column site_contact_name text;
alter table orders add column site_contact_phone text;
alter table orders add column site_access_notes text;

update orders o set
  site_contact_name = s.site_contact_name,
  site_contact_phone = s.site_contact_phone,
  site_access_notes = s.access_notes
from sites s
where s.id = o.site_id;

-- ================================================================
-- 2. create_order — identical to 0030 plus the three snapshot columns.
-- ================================================================
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
    site_contact_name, site_contact_phone, site_access_notes,
    product_name, variant,
    delivery_postcode, delivery_lat, delivery_lon,
    requested_by_id, requested_by, status, approval_was_required,
    stockist_id, stockist_name, stockist_website, stockist_postcode, pickup_estimate,
    total_price,
    needed_by_type, needed_by, delivery_method
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    v_site.site_contact_name, v_site.site_contact_phone, v_site.access_notes,
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
-- 3. edit_order — identical to 0030 plus: on a site move, re-snapshot the
--    three contact columns from the new site (directly, not coalesce'd —
--    the new site legitimately having no contact must clear the old one)
--    and record them in meta.changes.
-- ================================================================
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
    v_changes := v_changes || jsonb_build_object('siteContactName', jsonb_build_object('from', v_order.site_contact_name, 'to', v_site.site_contact_name));
    v_changes := v_changes || jsonb_build_object('siteContactPhone', jsonb_build_object('from', v_order.site_contact_phone, 'to', v_site.site_contact_phone));
    v_changes := v_changes || jsonb_build_object('siteAccessNotes', jsonb_build_object('from', v_order.site_access_notes, 'to', v_site.access_notes));
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
    site_contact_name = case when v_site.id is not null then v_site.site_contact_name else site_contact_name end,
    site_contact_phone = case when v_site.id is not null then v_site.site_contact_phone else site_contact_phone end,
    site_access_notes = case when v_site.id is not null then v_site.access_notes else site_access_notes end,
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
