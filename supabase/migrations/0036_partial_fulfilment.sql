-- Partial fulfilment reporting (product-audit gap fix — optional).
--
-- On 'Delivered', the driver MAY flag specific line items as short or
-- missing, with a note. It never blocks completion — the order still becomes
-- 'delivered' — it just records the truth: which items didn't fully arrive.
-- orders.fulfilment_status becomes 'full' or 'partial' at delivery, and the
-- flagged order_items carry delivered_short + shortfall_note.
--
-- mark_delivered gains a p_shortfalls jsonb array (default '[]', so an
-- existing 3-arg call is unaffected) of { itemId, note }. Signature change
-- => drop + recreate + re-grant, following the 0019 / 0026 precedent.

alter table order_items
  add column delivered_short boolean not null default false,
  add column shortfall_note text;

alter table orders
  add column fulfilment_status text check (fulfilment_status is null or fulfilment_status in ('full', 'partial'));

drop function if exists mark_delivered(uuid, timestamptz, text);

create or replace function mark_delivered(
  p_order_id uuid,
  p_delivery_time timestamptz,
  p_delivery_location text,
  p_shortfalls jsonb default '[]'::jsonb
) returns orders
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype; v_actor_name text; v_message text;
  v_partial boolean; v_short_count integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_delivery_time is null or p_delivery_location is null or btrim(p_delivery_location) = '' then
    raise exception 'delivery time and location are required' using errcode = '23514';
  end if;

  if p_shortfalls is null or jsonb_typeof(p_shortfalls) <> 'array' then
    raise exception 'shortfalls must be a json array' using errcode = '22023';
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

  -- Apply the shortfall flags (only items that really belong to this order).
  update order_items oi set
    delivered_short = true,
    shortfall_note = nullif(btrim(coalesce(s.elem->>'note', '')), '')
  from jsonb_array_elements(p_shortfalls) s(elem)
  where oi.order_id = p_order_id
    and oi.id = (s.elem->>'itemId')::uuid;

  select count(*) into v_short_count from order_items where order_id = p_order_id and delivered_short;
  v_partial := v_short_count > 0;

  update orders set fulfilment_status = case when v_partial then 'partial' else 'full' end
  where id = p_order_id
  returning * into v_order;

  insert into order_events (order_id, community_id, type, actor_id, actor_name, from_status, to_status, meta)
  values (p_order_id, v_order.community_id, 'delivered', auth.uid(), _current_display_name(), 'collected', 'delivered',
          jsonb_build_object('deliveryTime', p_delivery_time, 'deliveryLocation', p_delivery_location,
                             'fulfilmentStatus', v_order.fulfilment_status, 'shortItemCount', v_short_count));

  v_actor_name := coalesce(nullif(_current_display_name(), ''), 'The driver');
  v_message := format('%s for %s was delivered to %s%s', _order_label(v_order.product_name, v_order.variant),
                      coalesce(v_order.site_name, 'the site'), v_order.delivery_location,
                      case when v_partial then format(' — partial, %s item%s short.', v_short_count, case when v_short_count = 1 then '' else 's' end) else '.' end);

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

revoke execute on function mark_delivered(uuid, timestamptz, text, jsonb) from public, anon;
grant execute on function mark_delivered(uuid, timestamptz, text, jsonb) to authenticated;
