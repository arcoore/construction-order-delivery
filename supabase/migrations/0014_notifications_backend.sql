-- Phase 8D.1 — server-backed notifications. Forward-only; 0001-0013 are NOT
-- edited. Moves notification CREATION server-side (0007's schema deliberately
-- had no INSERT policy for `authenticated` — "notifications are always a
-- system-generated side effect", see that migration's comment — this is the
-- writer that comment always intended). Reads/mark-read/preferences stay
-- direct client calls against the existing `authenticated` grants + RLS from
-- 0009/0007 (select/update on notifications, select/insert/update on
-- notification_preferences, both already scoped to auth.uid() by RLS) — no
-- change needed there, only creation was ever the gap.
--
-- TWO creation paths, matching where the underlying authoritative event
-- already happens:
--   1. Order-lifecycle notifications (12 types) are appended inside the
--      existing order-lifecycle RPCs (0010/0013), in the same transaction as
--      the order_events insert those functions already do — content is
--      computed from the row THIS function itself just validated and wrote,
--      never from client input, exactly mirroring the append-only event log.
--   2. Non-order notifications (7 types: buyer access, site membership/
--      archive) come from direct client table writes in community.js/
--      sites.js, not RPCs — for these, seven narrow notify_* RPCs are added
--      below, each called by the client immediately after its already-
--      authorized direct write succeeds. Each one independently RE-VALIDATES
--      the specific claim against the row that write just produced (or,
--      where that row has since been deleted — revoke/remove — against
--      is_owner/has_buyer_grant-style live state) before inserting anything.
--      A caller cannot forge a notification for a fact that isn't true.
--
-- Every function here follows 0013's hardening discipline: an explicit
-- `auth.uid() is null` guard first, `is distinct from` for identity
-- comparisons, and an explicit revoke-from-public/anon + grant-to-
-- authenticated block at the end of this file for every new/replaced
-- signature (CREATE OR REPLACE does not touch existing ACLs, so this must be
-- restated even for functions whose signature is unchanged from 0010/0013 —
-- in practice their ACL already carries over correctly from 0013's own
-- block, but the internal helpers and the 7 new notify_* functions are new
-- and default to PUBLIC-executable unless explicitly revoked, exactly the
-- class of gap 0013 fixed for edit_order).

-- ======================================================================
-- Internal helpers — not callable directly by any client role (see the
-- revoke block at the end). Only ever invoked from inside another
-- SECURITY DEFINER function, which runs as this function's owner by the
-- time it calls these, so no direct grant to authenticated is needed.
-- ======================================================================

create or replace function _order_label(p_product_name text, p_variant text)
returns text
language sql immutable set search_path = public as $$
  select p_product_name || case when p_variant is not null and btrim(p_variant) <> '' then ' (' || p_variant || ')' else '' end;
$$;

-- Matches data.js's formatPrice exactly: `£${amount.toFixed(2)}` — two
-- decimals, no thousands separator.
create or replace function _format_price(p_amount numeric)
returns text
language sql immutable set search_path = public as $$
  select '£' || to_char(coalesce(p_amount, 0), 'FM999999999990.00');
$$;

-- Mirrors notifications.js's NOTIFICATION_TYPES + DEFAULT_PREFS +
-- isTypeEnabledFor exactly (category, configurable, subKey, and the three
-- sub-switches' default-OFF vs the four category presets' default-ON) — this
-- is the single source of truth for creation-time preference filtering
-- across every insert below, so the semantics can never drift between call
-- sites the way copy-pasted checks could.
create or replace function notification_type_enabled_for(p_user_id uuid, p_type text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_configurable boolean := true;
  v_subcol text := null;
  v_category text := null;
  v_prefs notification_preferences%rowtype;
begin
  case p_type
    when 'order_awaiting_approval' then v_category := 'approval';
    when 'order_rejected' then v_category := 'approval';
    when 'approval_reverted' then v_category := 'approval';
    when 'order_ready_for_purchase' then v_category := 'order';
    when 'delivery_available' then v_category := 'delivery'; v_subcol := 'delivery_available_enabled';
    when 'delivery_claimed' then v_category := 'delivery'; v_subcol := 'delivery_claimed_enabled';
    when 'delivery_cancelled' then v_category := 'delivery';
    when 'delivery_collected' then v_category := 'delivery'; v_subcol := 'delivery_collected_enabled';
    when 'order_delivered' then v_category := 'delivery';
    when 'buyer_access_requested' then v_category := 'role';
    when 'buyer_access_granted' then v_configurable := false;
    when 'buyer_access_rejected' then v_category := 'role';
    when 'buyer_access_revoked' then v_configurable := false;
    when 'site_member_added' then v_configurable := false;
    when 'site_member_removed' then v_configurable := false;
    when 'site_archived' then v_configurable := false;
    when 'cancellation_requested' then v_category := 'order';
    when 'cancellation_approved' then v_category := 'order';
    when 'cancellation_rejected' then v_category := 'order';
    else v_configurable := true;
  end case;

  if not v_configurable then
    return true;
  end if;

  select * into v_prefs from notification_preferences where user_id = p_user_id;
  if not found then
    -- No record = all four category presets true, all three sub-switches
    -- false — see notifications.js's DEFAULT_PREFS.
    return v_subcol is null;
  end if;

  if v_subcol = 'delivery_available_enabled' then return coalesce(v_prefs.delivery_available_enabled, false); end if;
  if v_subcol = 'delivery_claimed_enabled' then return coalesce(v_prefs.delivery_claimed_enabled, false); end if;
  if v_subcol = 'delivery_collected_enabled' then return coalesce(v_prefs.delivery_collected_enabled, false); end if;

  case v_category
    when 'order' then return coalesce(v_prefs.order_updates, true);
    when 'approval' then return coalesce(v_prefs.approval_updates, true);
    when 'delivery' then return coalesce(v_prefs.delivery_updates, true);
    when 'role' then return coalesce(v_prefs.role_updates, true);
    else return true;
  end case;
end;
$$;

-- ======================================================================
-- Order-lifecycle RPCs — CREATE OR REPLACE with identical signatures to
-- 0013, existing logic byte-for-byte unchanged, only a notification insert
-- appended after each function's existing order_events insert(s).
-- ======================================================================

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
  v_actor_name text;
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

-- =============================================================== edit_order
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
  v_actor_name text;
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

-- ============================================================ approve_order
create or replace function approve_order(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text;
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

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The owner');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
  select uid, 'order_ready_for_purchase', 'orderUpdates', 'Order ready to purchase',
    format('%s for %s — %s — was approved and is ready to purchase.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), _format_price(v_order.total_price)),
    v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
  from (select user_id as uid from buyer_grants where community_id = v_order.community_id) buyers
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'order_ready_for_purchase');

  return v_order;
end;
$$;

-- ============================================================= reject_order
create or replace function reject_order(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text;
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

  if v_order.requested_by_id is not null then
    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The owner');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.requested_by_id, 'order_rejected', 'approvalUpdates', 'Your order was rejected',
      format('%s rejected %s for %s%s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), case when p_reason is not null and btrim(p_reason) <> '' then ': ' || p_reason else '.' end),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.requested_by_id, 'order_rejected');
  end if;

  return v_order;
end;
$$;

-- ========================================================== revert_approval
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

-- ========================================================= complete_purchase
create or replace function complete_purchase(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text;
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

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The buyer');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
  select uid, 'delivery_available', 'deliveryUpdates', 'New delivery available',
    format('%s for %s is ready for pickup from %s.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), coalesce(v_order.stockist_name, 'the stockist')),
    v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', v_order.community_id, 'role', 'driver', 'orderId', v_order.id, 'siteId', v_order.site_id)
  from (select user_id as uid from community_memberships where community_id = v_order.community_id and status = 'approved') members
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'delivery_available');

  return v_order;
end;
$$;

-- ============================================================ claim_delivery
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

  update orders set
    status = 'claimed',
    driver_id = auth.uid(), driver = _current_display_name(), claimed_at = now(),
    version = version + 1
  where id = p_order_id and status = 'purchased' and driver_id is null
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

-- =========================================================== cancel_delivery
create or replace function cancel_delivery(p_order_id uuid, p_reason text)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_prev_driver_id uuid; v_prev_driver_name text; v_actor_name text;
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

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The driver');

  if v_order.purchased_by_id is not null then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.purchased_by_id, 'delivery_cancelled', 'deliveryUpdates', 'Delivery cancelled',
      format('%s cancelled the delivery for %s for %s: %s. It''s back in the driver pool.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), p_reason),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'delivery_cancelled');
  end if;

  insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
  select uid, 'delivery_cancelled', 'deliveryUpdates', 'Delivery cancelled',
    format('%s cancelled the delivery for %s for %s: %s.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), p_reason),
    v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', v_order.community_id, 'role', 'owner', 'orderId', v_order.id, 'siteId', v_order.site_id)
  from (
    select owner_id as uid from communities where id = v_order.community_id
    union select user_id from owner_grants where community_id = v_order.community_id
  ) owners
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'delivery_cancelled');

  return v_order;
end;
$$;

-- ============================================================ mark_collected
create or replace function mark_collected(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_actor_name text;
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

  if v_order.purchased_by_id is not null then
    v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The driver');
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.purchased_by_id, 'delivery_collected', 'deliveryUpdates', 'Order collected',
      format('%s for %s has been collected and is on its way.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'delivery_collected');
  end if;

  return v_order;
end;
$$;

-- ============================================================ mark_delivered
create or replace function mark_delivered(p_order_id uuid, p_delivery_time timestamptz, p_delivery_location text)
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

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The driver');
  v_message := format('%s for %s was delivered to %s.', _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), v_order.delivery_location);

  if v_order.purchased_by_id is not null then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, site_id, actor_id, actor_name, navigation_target)
    select v_order.purchased_by_id, 'order_delivered', 'deliveryUpdates', 'Order delivered', v_message,
      v_order.community_id, v_order.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'order_delivered');
  end if;
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

-- ======================================================== cancel_order_direct
-- No notification in the pre-existing JS behavior for a direct cancel —
-- unchanged, byte-for-byte identical to 0013, restated here only so this
-- migration is a complete, self-contained snapshot of every lifecycle
-- function's current body (matches the precedent already set by 0013
-- restating every function even where only some needed the actual fix).
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
  if v_order.status not in ('purchased', 'claimed') then
    raise exception 'cancellation requests are only available after purchase, before collection' using errcode = '42501';
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
      format('%s requested to cancel %s for %s: %s', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site'), p_reason),
      v_order.community_id, v_order.id, v_request.id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'buyer', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_order.purchased_by_id is distinct from auth.uid() and notification_type_enabled_for(v_order.purchased_by_id, 'cancellation_requested');
  end if;

  return v_request;
end;
$$;

-- ================================================= decide_cancellation_request
create or replace function decide_cancellation_request(p_request_id uuid, p_decision cancellation_request_status, p_decision_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_request cancellation_requests%rowtype; v_order orders%rowtype;
  v_prev_driver_id uuid; v_prev_driver_name text; v_actor_name text;
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

  -- p_decision = 'approved': the underlying cancel_order transition has no
  -- edge at 'collected' or beyond — if the order has already moved past
  -- 'purchased'/'claimed', this table itself refuses the transition, not a
  -- hand-written status check. No notification on this auto-close branch,
  -- matching the pre-existing JS behavior exactly (orderLifecycle.js only
  -- notified when result.ok was true).
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

  if v_request.requested_by_id is not null then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, order_id, request_id, site_id, actor_id, actor_name, navigation_target)
    select v_request.requested_by_id, 'cancellation_approved', 'orderUpdates', 'Cancellation approved',
      format('%s approved your cancellation request for %s for %s.', v_actor_name, _order_label(v_order.product_name, v_order.variant), coalesce(v_order.site_name, 'the site')),
      v_order.community_id, v_order.id, p_request_id, v_order.site_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_order.community_id, 'role', 'worker', 'orderId', v_order.id, 'siteId', v_order.site_id)
    where v_request.requested_by_id is distinct from auth.uid() and notification_type_enabled_for(v_request.requested_by_id, 'cancellation_approved');
  end if;

  return jsonb_build_object('ok', true, 'result', 'cancelled');
end;
$$;

-- ======================================================================
-- Non-order notify_* RPCs — called directly by community.js/sites.js
-- immediately after their existing, already-authorized direct table write
-- succeeds. Each re-validates the specific claim independently rather than
-- trusting the client's say-so:
--   - granted/added: the row the direct write just created must exist with
--     the actor as its own granted_by_id/added_by_id.
--   - revoked/removed: the row is already gone by the time this is called,
--     so re-validated against live is_owner state instead (same trust level
--     RLS itself already applied to the delete that just happened).
--   - requested/rejected/archived: re-validated against the relevant row's
--     own current status/actor columns.
-- ======================================================================

-- ------------------------------------------------------- buyer access grant
create or replace function notify_buyer_access_granted(p_community_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not exists (
    select 1 from buyer_grants
    where community_id = p_community_id and user_id = p_recipient_id and granted_by_id = auth.uid()
  ) then
    raise exception 'no matching buyer grant found for this actor' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'buyer_access_granted', 'roleUpdates', 'You''ve been granted buyer access',
      format('%s gave you buyer access.', v_actor_name), p_community_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', p_community_id, 'role', 'buyer'));
  end if;
end;
$$;

-- ------------------------------------------------------ buyer access revoke
create or replace function notify_buyer_access_revoked(p_community_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not is_owner(p_community_id, auth.uid()) then
    raise exception 'only an owner may notify about a buyer access revocation' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'buyer_access_revoked', 'roleUpdates', 'Buyer access removed',
      format('%s removed your buyer access.', v_actor_name), p_community_id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', p_community_id));
  end if;
end;
$$;

-- --------------------------------------------------- buyer access requested
create or replace function notify_buyer_access_requested(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_request buyer_requests%rowtype; v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_request from buyer_requests where id = p_request_id;
  if not found then raise exception 'buyer request not found' using errcode = '42704'; end if;
  if v_request.user_id is distinct from auth.uid() or v_request.status != 'pending' then
    raise exception 'no matching pending buyer request for this actor' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'A member');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, request_id, actor_id, actor_name, navigation_target)
  select uid, 'buyer_access_requested', 'roleUpdates', 'Buyer access requested',
    format('%s requested buyer access.', v_actor_name), v_request.community_id, v_request.id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', v_request.community_id, 'role', 'owner')
  from (
    select owner_id as uid from communities where id = v_request.community_id
    union select user_id from owner_grants where community_id = v_request.community_id
  ) owners
  where uid is distinct from auth.uid() and notification_type_enabled_for(uid, 'buyer_access_requested');
end;
$$;

-- ---------------------------------------------------- buyer access rejected
create or replace function notify_buyer_access_rejected(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_request buyer_requests%rowtype; v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_request from buyer_requests where id = p_request_id;
  if not found then raise exception 'buyer request not found' using errcode = '42704'; end if;
  if v_request.status != 'declined' or v_request.decided_by_id is distinct from auth.uid() then
    raise exception 'no matching declined buyer request decided by this actor' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if v_request.user_id is distinct from auth.uid() and notification_type_enabled_for(v_request.user_id, 'buyer_access_rejected') then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, request_id, actor_id, actor_name, navigation_target)
    values (v_request.user_id, 'buyer_access_rejected', 'roleUpdates', 'Buyer access request declined',
      format('%s declined your buyer access request.', v_actor_name), v_request.community_id, v_request.id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_request.community_id, 'view', 'profile'));
  end if;
end;
$$;

-- ------------------------------------------------------- site member added
create or replace function notify_site_member_added(p_site_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype; v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not exists (
    select 1 from site_memberships
    where site_id = p_site_id and user_id = p_recipient_id and added_by_id = auth.uid()
  ) then
    raise exception 'no matching site membership found for this actor' using errcode = '42501';
  end if;

  select * into v_site from sites where id = p_site_id;
  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, site_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'site_member_added', 'roleUpdates', 'Added to a site',
      format('%s added you to %s.', v_actor_name, v_site.name), v_site.community_id, v_site.id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_site.community_id, 'role', 'worker', 'siteId', v_site.id));
  end if;
end;
$$;

-- ----------------------------------------------------- site member removed
create or replace function notify_site_member_removed(p_site_id uuid, p_recipient_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype; v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_site from sites where id = p_site_id;
  if not found then raise exception 'site not found' using errcode = '42704'; end if;
  if not is_owner(v_site.community_id, auth.uid()) then
    raise exception 'only an owner may notify about a site member removal' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  if p_recipient_id is distinct from auth.uid() then
    insert into notifications (recipient_user_id, type, category, title, message, community_id, site_id, actor_id, actor_name, navigation_target)
    values (p_recipient_id, 'site_member_removed', 'roleUpdates', 'Removed from a site',
      format('%s removed you from %s.', v_actor_name, v_site.name), v_site.community_id, v_site.id, auth.uid(), v_actor_name,
      jsonb_build_object('communityId', v_site.community_id, 'role', 'worker', 'siteId', v_site.id));
  end if;
end;
$$;

-- ------------------------------------------------------------ site archived
create or replace function notify_site_archived(p_site_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype; v_actor_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;

  select * into v_site from sites where id = p_site_id;
  if not found then raise exception 'site not found' using errcode = '42704'; end if;
  if v_site.status != 'archived' or v_site.archived_by_id is distinct from auth.uid() then
    raise exception 'this site was not just archived by this actor' using errcode = '42501';
  end if;

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'An owner');
  insert into notifications (recipient_user_id, type, category, title, message, community_id, site_id, actor_id, actor_name, navigation_target)
  select user_id, 'site_archived', 'roleUpdates', 'Site archived',
    format('%s archived %s. You can no longer create new orders for it.', v_actor_name, v_site.name),
    v_site.community_id, v_site.id, auth.uid(), v_actor_name,
    jsonb_build_object('communityId', v_site.community_id, 'role', 'worker', 'siteId', v_site.id)
  from site_memberships
  where site_id = p_site_id and user_id is distinct from auth.uid();
end;
$$;

-- =====================================================================
-- Explicit grants. The three internal helpers get NO grant to any client
-- role (revoked from public/anon/authenticated) — they're only ever called
-- from inside another SECURITY DEFINER function, which runs as that
-- function's owner by then and needs no separate grant. The 7 notify_* RPCs
-- get the same authenticated-only pattern as every order-lifecycle RPC.
-- The 12 order-lifecycle functions above keep their exact 0013 signatures —
-- their ACL already carries over unchanged from 0013's own grant block
-- (CREATE OR REPLACE doesn't touch existing ACLs), so no restatement is
-- needed for them here.
-- =====================================================================
revoke execute on function
  _order_label(text, text),
  _format_price(numeric),
  notification_type_enabled_for(uuid, text)
from public, anon, authenticated;

revoke execute on function
  notify_buyer_access_granted(uuid, uuid),
  notify_buyer_access_revoked(uuid, uuid),
  notify_buyer_access_requested(uuid),
  notify_buyer_access_rejected(uuid),
  notify_site_member_added(uuid, uuid),
  notify_site_member_removed(uuid, uuid),
  notify_site_archived(uuid)
from public, anon;

grant execute on function
  notify_buyer_access_granted(uuid, uuid),
  notify_buyer_access_revoked(uuid, uuid),
  notify_buyer_access_requested(uuid),
  notify_buyer_access_rejected(uuid),
  notify_site_member_added(uuid, uuid),
  notify_site_member_removed(uuid, uuid),
  notify_site_archived(uuid)
to authenticated;
