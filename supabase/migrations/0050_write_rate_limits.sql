-- Rate limits on the two authenticated write paths most exposed to abuse by
-- a logged-in account acting in bad faith (a malicious/compromised member,
-- not an anonymous attacker) — pre-launch security pass, 2026-09-11.
--
-- THE GAP
-- -------
-- Migration 0047 closed the one hole reachable with *no* account at all
-- (client_errors, anon-writable). But create_order/send_order_message —
-- both genuine SECURITY DEFINER RPCs, RLS/grant-correct, no bypass — have
-- no ceiling on how FAST a single authenticated member can call them. A
-- member of a company (a real, confirmed, now CAPTCHA-gated signup — a much
-- higher bar than the anon case 0047 closed, but not zero) could script
-- hundreds of junk orders or spam messages into a real order thread in
-- seconds: flooding the owner's dashboard/notifications, or harassing
-- whoever else is on that thread. Same shape gap 0047/0048 already fixed
-- elsewhere in this schema, just not yet applied here.
--
-- Thresholds are deliberately generous — this stops a script, not a busy
-- human. No real worker creates 20 separate orders or sends 20 messages
-- in under a minute by hand; a multi-item cart is still exactly one
-- create_order call regardless of how many products are in it.

-- ================================================================
-- 1. orders: cap how many a single requester can create per minute.
-- ================================================================
create or replace function _orders_rate_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (
    select count(*) from orders
    where requested_by_id = new.requested_by_id
      and created_at > now() - interval '60 seconds'
  ) >= 20 then
    raise exception 'orders: too many orders placed too quickly, please slow down' using errcode = '53400';
  end if;
  return new;
end;
$$;
revoke execute on function _orders_rate_guard() from public, anon, authenticated;

create trigger orders_rate_guard
  before insert on orders
  for each row execute function _orders_rate_guard();

-- Backs both this guard's own count query and any future "my recent
-- orders" read — same reasoning as 0049's other per-user cooldown index.
create index orders_requested_by_created_idx
  on orders (requested_by_id, created_at desc);

-- ================================================================
-- 2. order_messages: cap how many a single author can send per minute.
-- ================================================================
create or replace function _order_messages_rate_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (
    select count(*) from order_messages
    where author_id = new.author_id
      and created_at > now() - interval '60 seconds'
  ) >= 20 then
    raise exception 'order_messages: too many messages sent too quickly, please slow down' using errcode = '53400';
  end if;
  return new;
end;
$$;
revoke execute on function _order_messages_rate_guard() from public, anon, authenticated;

create trigger order_messages_rate_guard
  before insert on order_messages
  for each row execute function _order_messages_rate_guard();

create index order_messages_author_created_idx
  on order_messages (author_id, created_at desc);
