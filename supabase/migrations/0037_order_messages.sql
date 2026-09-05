-- In-app messaging: a per-order comment thread (product-audit gap fix).
--
-- The people around one order — the worker who requested it, the owner, the
-- buyer, the driver — had no way to talk about it in SiteStock. This adds a
-- lightweight append-only thread per order (like order_events, but
-- user-authored). Anyone who can see the order can read and post; nobody can
-- edit or delete a message.
--
-- Visibility mirrors order_items exactly (owner / requester / driver /
-- site-access / buyer-for-site). Posting goes through a SECURITY DEFINER RPC
-- so the author_name snapshot is server-set (same discipline as order
-- events) and the visibility check can't be bypassed by a crafted insert.

create table order_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  community_id uuid not null,
  author_id uuid not null references profiles (id),
  author_name text not null,
  body text not null check (btrim(body) <> ''),
  created_at timestamptz not null default now()
);
create index order_messages_order_idx on order_messages (order_id, created_at);

alter table order_messages enable row level security;
grant select on order_messages to authenticated;
-- No insert/update/delete grant — RPC-only (SECURITY DEFINER bypasses RLS).

create policy order_messages_select on order_messages
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = order_messages.order_id
        and (
          is_owner(o.community_id, auth.uid())
          or o.requested_by_id = auth.uid()
          or o.driver_id = auth.uid()
          or can_access_site(o.site_id, o.community_id, auth.uid())
          or can_purchase_for_site(o.site_id, o.community_id, auth.uid())
        )
    )
  );

create or replace function send_order_message(p_order_id uuid, p_body text)
returns order_messages
language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_message order_messages%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'a message cannot be empty' using errcode = '22023';
  end if;
  if length(p_body) > 2000 then
    raise exception 'message too long (2000 characters max)' using errcode = '22023';
  end if;

  select * into v_order from orders where id = p_order_id;
  if not found then raise exception 'order not found' using errcode = '42704'; end if;

  if not (
    is_owner(v_order.community_id, auth.uid())
    or v_order.requested_by_id = auth.uid()
    or v_order.driver_id = auth.uid()
    or can_access_site(v_order.site_id, v_order.community_id, auth.uid())
    or can_purchase_for_site(v_order.site_id, v_order.community_id, auth.uid())
  ) then
    raise exception 'not authorized to message on this order' using errcode = '42501';
  end if;

  insert into order_messages (order_id, community_id, author_id, author_name, body)
  values (p_order_id, v_order.community_id, auth.uid(), coalesce(nullif(_current_display_name(), ''), 'Someone'), btrim(p_body))
  returning * into v_message;

  return v_message;
end;
$$;

revoke execute on function send_order_message(uuid, text) from public, anon;
grant execute on function send_order_message(uuid, text) to authenticated;

-- Realtime: order_messages is community-scoped, rides the existing
-- community channel (see realtime.js). Live thread updates are the whole
-- point of a chat, so unlike order_events this one IS published.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'order_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.order_messages';
  END IF;
END $$;
