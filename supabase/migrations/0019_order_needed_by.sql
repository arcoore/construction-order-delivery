-- Roadmap Step 2 — structured "Needed by" deadlines. Two new nullable
-- columns on orders, following the exact same additive/no-version-bump
-- precedent already used for requireOwnerApproval, siteId, and the Phase 7B
-- cancellation fields (see CLAUDE.md). No table redesign, no new lifecycle
-- status, no new order_events type, no new notification type, no RLS
-- change, no Realtime change — orders is already published and this rides
-- along on the existing authoritative order-cache refresh.
--
-- DATA MODEL — deliberately only two type values, not four:
--   needed_by_type = null      -> needed_by = null   ("not specified", historical orders only)
--   needed_by_type = 'asap'    -> needed_by = null    (a genuine choice: no concrete deadline)
--   needed_by_type = 'deadline'-> needed_by = <real future timestamptz>
-- There is deliberately no stored 'today'/'tomorrow'/'custom' type. Those
-- are UI-only shortcuts (public/js/deadline.js) that all resolve to the
-- exact same 'deadline' type with a real timestamp — the timestamp is the
-- only source of truth. Storing 'today'/'tomorrow' as a type would let a
-- displayed label go stale once real time moves past the value that
-- produced it (an order created "for tomorrow" and viewed two days later
-- must not still say "Tomorrow") — every UI layer instead computes
-- Today/Tomorrow/absolute-date labels fresh at render time by comparing the
-- stored timestamp to the current date, never by trusting a frozen type.
--
-- ASAP IS NOT now() — storing the creation instant as a deadline would make
-- an ASAP order technically overdue the moment it's created. ASAP is a pure
-- urgency signal with no concrete timestamp at all.

alter table orders
  add column needed_by_type text,
  add column needed_by timestamptz;

-- Single constraint covers BOTH "is needed_by_type one of the two legal
-- values (or null)" and "does needed_by's presence/absence match that
-- type" — no other combination is representable. Deliberately NOT
-- referencing now() here (a CHECK constraint must stay immutable-evaluable
-- and must never re-validate against a moving "now" on every future touch
-- of an unrelated column) — the separate, real "must be in the future"
-- rule lives in create_order/edit_order below instead, exactly where it
-- can correctly apply only at the moment a deadline is actually being set.
--
-- Written as a searched CASE with an explicit ELSE false, NOT as
-- `(needed_by_type = 'x' and ...) or ...` — a real bug caught during local
-- verification: `needed_by_type = 'asap'` evaluates to SQL NULL (not
-- FALSE) whenever needed_by_type itself is NULL, and Postgres CHECK
-- constraints treat a NULL result as PASSING, per the SQL standard ("a
-- check constraint is satisfied if the expression evaluates to true or
-- null"). That let `needed_by_type = NULL, needed_by = <a real timestamp>`
-- silently slip through the OR-of-equality-comparisons form below, since
-- every branch evaluated to FALSE or NULL and never to a hard FALSE
-- overall. The CASE form's `when needed_by_type is null then ...` branch
-- and the explicit `else false` both always resolve to a real boolean,
-- closing that gap for good.
alter table orders add constraint orders_needed_by_valid_state check (
  case
    when needed_by_type is null then needed_by is null
    when needed_by_type = 'asap' then needed_by is null
    when needed_by_type = 'deadline' then needed_by is not null
    else false
  end
);

-- ============================================================ create_order
-- New signature (18 params, was 16) — the old signature has no separate
-- overload to drop first since CREATE OR REPLACE with an unchanged
-- parameter list+types replaces in place; adding two new trailing params
-- changes the signature, so the prior 16-arg version must be dropped
-- explicitly first (same rule 0012's header already documented for
-- edit_order) or Postgres would keep both as separate overloaded
-- functions, breaking supabase.rpc('create_order', ...) callers with an
-- ambiguous-function error.
drop function if exists create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric);

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
  p_needed_by timestamptz
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

  -- The co-presence/valid-type-value shape is already fully enforced by
  -- orders_needed_by_valid_state above (would raise 23514 on its own) — the
  -- one thing that constraint cannot express is "in the future", which is
  -- inherently relative to the moment of this call, not a static shape.
  if p_needed_by_type = 'deadline' and p_needed_by <= now() then
    raise exception 'needed_by must be in the future' using errcode = '22023';
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
    needed_by_type, needed_by
  ) values (
    p_community_id, p_site_id, v_site.name, v_site.address, v_site.postcode, v_site.delivery_instructions,
    p_product_id, p_product_name, p_variant, p_quantity, p_unit,
    p_delivery_postcode, p_delivery_lat, p_delivery_lon,
    auth.uid(), _current_display_name(), v_status, v_approval_required,
    p_stockist_id, p_stockist_name, p_stockist_website, p_stockist_postcode, p_pickup_estimate,
    p_unit_price, p_unit_price * p_quantity,
    p_needed_by_type, p_needed_by
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
-- New signature (19 params, was 17) — same drop-then-recreate rule as above.
drop function if exists edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric);

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
  p_unit_price numeric,
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

  -- Only validated/diffed when the deadline is ACTUALLY changing — an
  -- unrelated edit (e.g. only quantity) on an order whose existing deadline
  -- has since naturally passed must remain possible, per the approved
  -- design. orders_needed_by_valid_state (the table CHECK) still catches
  -- any malformed pairing regardless of whether this branch runs.
  if p_needed_by_type is distinct from v_order.needed_by_type or p_needed_by is distinct from v_order.needed_by then
    if p_needed_by_type = 'deadline' and p_needed_by <= now() then
      raise exception 'needed_by must be in the future' using errcode = '22023';
    end if;
    v_changes := v_changes || jsonb_build_object('neededByType', jsonb_build_object('from', v_order.needed_by_type, 'to', p_needed_by_type));
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
    needed_by_type = p_needed_by_type,
    needed_by = p_needed_by,
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

-- =====================================================================
-- Explicit defense-in-depth re-assertion of grants, exact signatures —
-- CREATE OR REPLACE does not carry a function's ACL forward when the
-- signature changes (it's a genuinely new function from Postgres's
-- perspective), and a newly created function is PUBLIC-executable by
-- default unless explicitly revoked — the exact gap class 0013 closed for
-- every lifecycle RPC. Mirrors 0013's own revoke-then-grant block exactly,
-- scoped to only the two signatures that actually changed this migration.
-- =====================================================================
revoke execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz),
  edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)
from public, anon;

grant execute on function
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric, text, timestamptz),
  edit_order(uuid, integer, text, text, text, numeric, text, text, double precision, double precision, uuid, text, text, text, text, text, numeric, text, timestamptz)
to authenticated;
