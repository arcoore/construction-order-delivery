-- Company ownership transfer (product-audit gap fix).
--
-- Before this, communities.owner_id was set once at creation and could
-- never change — an owner who left the business had no way to hand the
-- company over, and creator-account deletion was permanently blocked (the
-- FK from communities.owner_id -> profiles(id) has no cascade, on purpose).
--
-- Design:
--   * Only the TRUE creator (is_creator, not a granted owner) can transfer.
--   * The new owner must already be an approved member of the company.
--   * The outgoing creator does NOT lose access — they get an owner_grants
--     row, so they stay owner-level but are no longer THE creator. This
--     matches "I'm handing over the company but I still work here."
--   * The incoming owner's own owner_grants row (if any) is removed as
--     redundant — they're the creator now.
--   * Guarded + row-locked exactly like every other state-machine RPC in
--     this codebase (decide_join_request, the workforce-lifecycle RPCs).
--   * One notification to the new owner, non-configurable (it changes their
--     own access level, same rule as buyer_access_granted / membership_*).
--
-- No community_membership_events audit row: that table is keyed to a
-- membership_id, and neither the creator nor necessarily the new owner has
-- one. Ownership transfer is rare and both parties are notified; a dedicated
-- audit surface for it is out of scope here.

alter table notifications drop constraint notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in (
  'order_awaiting_approval', 'order_rejected', 'approval_reverted', 'order_ready_for_purchase',
  'delivery_available', 'delivery_claimed', 'delivery_cancelled', 'delivery_collected', 'order_delivered',
  'buyer_access_requested', 'buyer_access_granted', 'buyer_access_rejected', 'buyer_access_revoked',
  'site_member_added', 'site_member_removed', 'site_archived',
  'cancellation_requested', 'cancellation_approved', 'cancellation_rejected',
  'membership_approved', 'membership_declined',
  'membership_suspended', 'membership_restored', 'membership_removed', 'member_left',
  'ownership_transferred'
));

-- Recreate with ownership_transferred registered as non-configurable
-- (byte-identical to 0023's body otherwise).
create or replace function notification_type_enabled_for(p_user_id uuid, p_type text)
returns boolean
language plpgsql security definer set search_path = public as $$
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
    when 'membership_approved' then v_configurable := false;
    when 'membership_declined' then v_configurable := false;
    when 'membership_suspended' then v_configurable := false;
    when 'membership_restored' then v_configurable := false;
    when 'membership_removed' then v_configurable := false;
    when 'member_left' then v_category := 'role';
    when 'ownership_transferred' then v_configurable := false;
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

-- ================================================================
create or replace function transfer_ownership(p_community_id uuid, p_new_owner_id uuid)
returns communities
language plpgsql security definer set search_path = public as $$
declare
  v_community communities%rowtype;
  v_old_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_community from communities where id = p_community_id for update;
  if not found then raise exception 'company not found' using errcode = '42704'; end if;

  if v_community.owner_id is distinct from auth.uid() then
    raise exception 'only the company creator can transfer ownership' using errcode = '42501';
  end if;
  if p_new_owner_id = auth.uid() then
    raise exception 'you already own this company' using errcode = '22023';
  end if;
  if not is_approved_member(p_community_id, p_new_owner_id) then
    raise exception 'the new owner must be an approved member of the company' using errcode = '22023';
  end if;

  v_old_owner := v_community.owner_id;

  update communities set owner_id = p_new_owner_id where id = p_community_id
  returning * into v_community;

  -- Outgoing creator keeps owner-level access as a granted owner.
  insert into owner_grants (community_id, user_id, granted_by_id)
  values (p_community_id, v_old_owner, p_new_owner_id)
  on conflict (community_id, user_id) do nothing;

  -- Incoming owner no longer needs a grant — they're the creator now.
  delete from owner_grants where community_id = p_community_id and user_id = p_new_owner_id;

  insert into notifications (recipient_user_id, type, category, title, message, community_id, actor_id, actor_name, navigation_target)
  values (
    p_new_owner_id, 'ownership_transferred', 'roleUpdates', 'You''re now the company owner',
    format('%s transferred ownership of %s to you.', coalesce(nullif((select display_name from profiles where id = v_old_owner), ''), 'The previous owner'), v_community.name),
    p_community_id, auth.uid(), (select display_name from profiles where id = v_old_owner),
    jsonb_build_object('communityId', p_community_id, 'role', 'owner')
  );

  return v_community;
end;
$$;

revoke execute on function transfer_ownership(uuid, uuid) from public, anon;
grant execute on function transfer_ownership(uuid, uuid) to authenticated;
