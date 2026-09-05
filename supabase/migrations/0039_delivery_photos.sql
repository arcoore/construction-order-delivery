-- Photo proof of delivery (product-audit gap fix — optional).
--
-- The driver MAY attach one or more photos when (or after) marking an order
-- delivered. Never required. Files live in a private Storage bucket keyed by
-- order id (<order_id>/<uuid>); a delivery_photos row records each one so the
-- association is queryable and RLS-scoped like the rest of the order.
--
--   - bucket 'delivery-photos', private.
--   - storage.objects policies: an authenticated user may upload into
--     <order_id>/... only if they are that order's assigned driver and the
--     order is collected/delivered; anyone who can see the order may read.
--   - delivery_photos table: select = can see the order; no direct
--     insert/update/delete — add_delivery_photo (SECURITY DEFINER) is the
--     only write path and re-checks the same driver/status condition.

-- --- delivery_photos table (created first — a storage policy references it) --
create table delivery_photos (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  community_id uuid not null,
  storage_path text not null unique,
  uploaded_by_id uuid not null references profiles (id),
  uploaded_at timestamptz not null default now()
);
create index delivery_photos_order_idx on delivery_photos (order_id);

alter table delivery_photos enable row level security;
grant select on delivery_photos to authenticated;

create policy delivery_photos_row_select on delivery_photos
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = delivery_photos.order_id
        and (
          is_owner(o.community_id, auth.uid())
          or o.requested_by_id = auth.uid()
          or o.driver_id = auth.uid()
          or can_access_site(o.site_id, o.community_id, auth.uid())
          or can_purchase_for_site(o.site_id, o.community_id, auth.uid())
        )
    )
  );

-- --- Storage bucket + object policies --------------------------------
insert into storage.buckets (id, name, public)
values ('delivery-photos', 'delivery-photos', false)
on conflict (id) do nothing;

-- (storage.foldername(name))[1] is the first path segment = the order id.
create policy delivery_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'delivery-photos'
    and exists (
      select 1 from public.orders o
      where o.id = ((storage.foldername(name))[1])::uuid
        and o.driver_id = auth.uid()
        and o.status in ('collected', 'delivered')
    )
  );

create policy delivery_photos_object_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'delivery-photos'
    and exists (
      select 1 from public.orders o
      where o.id = ((storage.foldername(name))[1])::uuid
        and (
          public.is_owner(o.community_id, auth.uid())
          or o.requested_by_id = auth.uid()
          or o.driver_id = auth.uid()
          or public.can_access_site(o.site_id, o.community_id, auth.uid())
          or public.can_purchase_for_site(o.site_id, o.community_id, auth.uid())
        )
    )
  );

-- the uploader may clean up an object that never got recorded (a failed
-- add_delivery_photo); once recorded, photos are permanent.
create policy delivery_photos_object_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'delivery-photos'
    and owner = auth.uid()
    and not exists (select 1 from public.delivery_photos dp where dp.storage_path = name)
  );

-- --- add_delivery_photo RPC ------------------------------------------
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
  if p_storage_path is null or p_storage_path not like (p_order_id::text || '/%') then
    raise exception 'photo path must be under this order''s folder' using errcode = '22023';
  end if;

  insert into delivery_photos (order_id, community_id, storage_path, uploaded_by_id)
  values (p_order_id, v_order.community_id, p_storage_path, auth.uid())
  returning * into v_photo;
  return v_photo;
end;
$$;

revoke execute on function add_delivery_photo(uuid, text) from public, anon;
grant execute on function add_delivery_photo(uuid, text) to authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'delivery_photos'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_photos';
  END IF;
END $$;
