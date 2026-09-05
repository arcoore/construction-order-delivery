-- Value-threshold second approval (product-audit gap fix).
--
-- A community can set approval_threshold. When owner approval is on AND an
-- order's total exceeds the threshold, it needs TWO approvals from two
-- DIFFERENT owners before it reaches the buyer. Below the threshold (or with
-- no threshold set), a single approval clears it exactly as before.
--
-- No new order_status value: a partly-approved order stays 'pending_approval'
-- with approved_by_id set (first approver) but second_approved_by_id still
-- null. approve_order routes on that.
--
--   pending_approval --approve(1st, needs 2nd)--> pending_approval (approved_by set)
--                    --approve(2nd, different owner)--> pending_purchase
--                    --approve(no 2nd needed)--> pending_purchase   (unchanged)
--
-- needs_second_approval is recomputed on every edit that changes the items
-- (using the community's threshold at that moment) since edit_and_reapprove
-- already resets approval — a worker can't shrink an order past the
-- threshold to dodge the second sign-off, or grow it and skip it.

alter table communities
  add column approval_threshold numeric check (approval_threshold is null or approval_threshold >= 0);

alter table orders
  add column needs_second_approval boolean not null default false,
  add column second_approved_by_id uuid references profiles (id),
  add column second_approved_by text,
  add column second_approved_at timestamptz;

-- ================================================================
-- create_order — snapshot needs_second_approval at creation.
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
  v_needs_second boolean;
  v_total numeric;
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
  v_total := _items_total(p_items);
  v_needs_second := v_approval_required
    and v_community.approval_threshold is not null
    and v_total > v_community.approval_threshold;
  v_status := case when v_approval_required then 'pending_approval' else 'pending_purchase' end;

  insert into orders (
    community_id, site_id, site_name, site_address, site_postcode, site_delivery_instructions,
    site_contact_name, site_contact_phone, site_access_notes,
    product_name, variant,
    delivery_postcode, delivery_lat, delivery_lon,
    requested_by_id, requested_by, status, approval_was_required, needs_second_approval,
    stockist_id, stockist_name, stockist_website, stockist_postcode, pickup_estimate,
    total_price,
    needed_by_type, needed_by, delivery_method
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    v_site.site_contact_name, v_site.site_contact_phone, v_site.access_notes,
    _items_headline_name(p_items), _items_headline_variant(p_items),
    p_delivery_postcode, p_delivery_lat, p_delivery_lon,
    auth.uid(), _current_display_name(), v_status, v_approval_required, v_needs_second,
    p_stockist_id, p_stockist_name, p_stockist_website, p_stockist_postcode, p_pickup_estimate,
    v_total,
    p_needed_by_type, p_needed_by, p_delivery_method
  ) returning * into v_order;

  perform _insert_order_items(v_order.id, p_community_id, p_items);

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (v_order.id, p_community_id, 'order_created', auth.uid(), _current_display_name(), null, v_status);

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A worker');

  if v_approval_required then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_awaiting_approval', 'approvalUpdates', 'New order needs approval',
      format('%s requested %s for %s.%s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'),
             case when v_needs_second then ' Two approvals are needed.' else '' end),
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
-- approve_order — first / second approval routing.
-- ================================================================
create or replace function approve_order(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text; v_stage text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.status <> 'pending_approval' then
    raise exception 'order is no longer awaiting approval' using errcode = '40001';
  end if;
  if not is_owner(v_order.community_id, auth.uid()) then
    raise exception 'only an owner may approve this order' using errcode = '42501';
  end if;

  if v_order.approved_by_id is null then
    -- First approval.
    if v_order.needs_second_approval then
      v_stage := 'first';
      update orders set
        approved_by_id = auth.uid(), approved_by = _current_display_name(), approved_at = now(),
        version = version + 1
      where id = p_order_id and status = 'pending_approval'
      returning * into v_order;
    else
      v_stage := 'only';
      update orders set
        status = 'pending_purchase',
        approved_by_id = auth.uid(), approved_by = _current_display_name(), approved_at = now(),
        version = version + 1
      where id = p_order_id and status = 'pending_approval'
      returning * into v_order;
    end if;
  else
    -- Second approval — must be a different owner.
    if v_order.approved_by_id = auth.uid() then
      raise exception 'you already gave the first approval — a second owner must give the other' using errcode = '42501';
    end if;
    v_stage := 'second';
    update orders set
      status = 'pending_purchase',
      second_approved_by_id = auth.uid(), second_approved_by = _current_display_name(), second_approved_at = now(),
      version = version + 1
    where id = p_order_id and status = 'pending_approval'
    returning * into v_order;
  end if;
  if not found then raise exception 'order is no longer awaiting approval' using errcode = '40001'; end if;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'approved', auth.uid(), _current_display_name(),
          'pending_approval', v_order.status, jsonb_build_object('stage', v_stage));

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The owner');

  if v_stage = 'first' then
    -- Tell the OTHER owners a second approval is still needed.
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_awaiting_approval', 'approvalUpdates', 'Order needs a second approval',
      format('%s approved %s for %s — it still needs a second owner''s approval.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'owner', 'orderId', v_order.id, 'siteId', v_order.site_id)
    from (
      select owner_id as uid from communities where id = v_order.community_id
      union select user_id from owner_grants where community_id = v_order.community_id
    ) owners
    where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_awaiting_approval');
  else
    -- Fully approved (single or second) — tell the buyers.
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select uid, 'order_ready_for_purchase', 'orderUpdates', 'Order ready to purchase',
      format('%s for %s — %s — was approved and is ready to purchase.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), _format_price(v_order.total_price)),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    from (select user_id as uid from buyer_grants where community_id = v_order.community_id) buyers
    where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_ready_for_purchase');
  end if;

  return v_order;
end;
$$;

-- ================================================================
-- revert_approval — also clear the second approval.
-- ================================================================
create or replace function revert_approval(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_decided_at timestamptz; v_actor_name text;
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

  v_decided_at := case when v_order.status = 'rejected' then v_order.rejected_at
                       else coalesce(v_order.second_approved_at, v_order.approved_at) end;
  if v_decided_at is null or now() - v_decided_at > interval '72 hours' then
    raise exception 'the 72-hour revert window has passed' using errcode = '42501';
  end if;

  update orders set
    status = 'pending_approval',
    approved_by_id = null, approved_by = null, approved_at = null,
    second_approved_by_id = null, second_approved_by = null, second_approved_at = null,
    rejected_by_id = null, rejected_by = null, rejected_at = null, rejection_reason = null,
    version = version + 1
  where id = p_order_id
  returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status)
  values (p_order_id, v_order.community_id, 'approval_reverted', auth.uid(), _current_display_name(), v_order.status, 'pending_approval');

  if v_order.requested_by_id is not null then
    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The owner');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.requested_by_id, 'approval_reverted', 'approvalUpdates', 'Approval decision reverted',
      format('%s reverted the decision on %s for %s — it''s back awaiting approval.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.requested_by_id, 'approval_reverted');
  end if;

  return v_order;
end;
$$;

-- ================================================================
-- edit_order — recompute needs_second_approval on any item change, clear
-- the second approval when forcing re-approval.
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
  v_threshold numeric;
  v_new_total numeric;
  v_needs_second boolean;
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

  v_new_total := _items_total(p_items);
  select approval_threshold into v_threshold from communities where id = v_order.community_id;
  v_needs_second := v_order.approval_was_required
    and v_threshold is not null
    and v_new_total > v_threshold;

  update orders set
    product_name = _items_headline_name(p_items),
    variant = _items_headline_variant(p_items),
    total_price = v_new_total,
    needs_second_approval = v_needs_second,
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
    second_approved_by_id = case when v_action = 'edit_and_reapprove' then null else second_approved_by_id end,
    second_approved_by = case when v_action = 'edit_and_reapprove' then null else second_approved_by end,
    second_approved_at = case when v_action = 'edit_and_reapprove' then null else second_approved_at end,
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
