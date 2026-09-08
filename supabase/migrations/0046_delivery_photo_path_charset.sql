-- Tighten add_delivery_photo's storage-path validation to a safe charset.
--
-- 0039 only checked the path started with "<order_id>/", so a hand-crafted
-- API call could record a photo whose stored path contained arbitrary text
-- (quotes, angle brackets, spaces, a second "/"). That text is later
-- rendered into a data-path="…" attribute (deliveryPhotosView.js) — now
-- escaped there too, but there is no reason to accept it at all. The real
-- upload path is always `${orderId}/${crypto.randomUUID()}.${ext}` with ext
-- reduced to [a-z0-9] (public/js/deliveryPhotos.js), so require the segment
-- after "<order_id>/" to be a single filename of [A-Za-z0-9._-] only — no
-- markup metacharacters, no further path segments.
--
-- Forward-only: 0039 is already applied everywhere and is not edited.

create or replace function add_delivery_photo(p_order_id uuid, p_storage_path text)
returns delivery_photos
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_photo delivery_photos%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_order from orders where id = p_order_id;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;
  if v_order.driver_id is distinct from auth.uid() then
    raise exception 'only the assigned driver may add a delivery photo' using errcode = '42501';
  end if;
  if v_order.status not in ('collected', 'delivered') then
    raise exception 'photos can only be added once the order is collected' using errcode = '42501';
  end if;
  -- <order_id>/<safe-filename> — one path segment, no markup metacharacters.
  if p_storage_path is null
     or p_storage_path !~ ('^' || p_order_id::text || '/[A-Za-z0-9._-]{1,120}$')
  then
    raise exception 'photo path must be <order id>/<simple filename>' using errcode = '22023';
  end if;

  insert into delivery_photos (order_id, community_id, storage_path, uploaded_by_id)
  values (p_order_id, v_order.community_id, p_storage_path, auth.uid())
  returning * into v_photo;
  return v_photo;
end;
$$;

revoke execute on function add_delivery_photo(uuid, text) from public, anon;
grant execute on function add_delivery_photo(uuid, text) to authenticated;
