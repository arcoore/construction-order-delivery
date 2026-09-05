-- Permanent deletion for sites and companies that never got used
-- (product-audit gap fix). Archiving stays the model for anything with
-- history; this only removes the genuinely-empty mistakes ("wrong name",
-- "test company") that would otherwise clutter the list forever.
--
--   delete_site: owner only, ONLY if no order has ever referenced the site.
--     (orders.site_id has no ON DELETE — the FK itself already blocks
--     orphaning an order; this RPC checks first for a friendly message and
--     cascades site_memberships.)
--   delete_community: CREATOR only, ONLY if the company has no orders, no
--     sites, and no members/grants other than the creator — i.e. nothing of
--     value can be lost. Everything left (the creator's own membership,
--     any stray notifications) is removed in the same transaction; the
--     ON DELETE CASCADE FKs handle the rest.

create or replace function delete_site(p_site_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_site from sites where id = p_site_id;
  if not found then raise exception 'site not found' using errcode = '42704'; end if;
  if not is_owner(v_site.community_id, auth.uid()) then
    raise exception 'only an owner may delete a site' using errcode = '42501';
  end if;
  if exists (select 1 from orders where site_id = p_site_id) then
    raise exception 'this site has orders on file — archive it instead of deleting' using errcode = '42501';
  end if;

  delete from site_memberships where site_id = p_site_id;
  delete from sites where id = p_site_id;
end;
$$;

create or replace function delete_community(p_community_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_community communities%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_community from communities where id = p_community_id;
  if not found then raise exception 'company not found' using errcode = '42704'; end if;
  if v_community.owner_id is distinct from auth.uid() then
    raise exception 'only the company creator may delete it' using errcode = '42501';
  end if;

  if exists (select 1 from orders where community_id = p_community_id) then
    raise exception 'this company has orders on file and cannot be deleted' using errcode = '42501';
  end if;
  if exists (select 1 from sites where community_id = p_community_id) then
    raise exception 'delete or archive this company''s sites first' using errcode = '42501';
  end if;
  if exists (
    select 1 from community_memberships
    where community_id = p_community_id
      and user_id <> auth.uid()
      and status in ('pending', 'approved', 'suspended')
  ) then
    raise exception 'this company still has members or pending requests — remove them first' using errcode = '42501';
  end if;
  if exists (select 1 from owner_grants where community_id = p_community_id and user_id <> auth.uid())
     or exists (select 1 from buyer_grants where community_id = p_community_id) then
    raise exception 'revoke every owner/buyer grant before deleting the company' using errcode = '42501';
  end if;

  -- notifications.community_id has no ON DELETE — clear any stragglers
  -- (e.g. the creator's own) so the communities delete isn't FK-blocked.
  delete from notifications where community_id = p_community_id;
  delete from communities where id = p_community_id;  -- cascades memberships/grants/requests
end;
$$;

revoke execute on function delete_site(uuid), delete_community(uuid) from public, anon;
grant execute on function delete_site(uuid), delete_community(uuid) to authenticated;
