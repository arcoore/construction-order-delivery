-- Explicit EXECUTE grants rather than relying on Postgres's default
-- (EXECUTE granted to PUBLIC on function creation) — in a security-
-- sensitive SECURITY DEFINER context, being explicit is worth the extra
-- lines. Only `authenticated` may call any of these; `anon` (an
-- unauthenticated visitor) gets none of them, matching the approved
-- decision to retire guest mode — there is no unauthenticated path into
-- company data at all going forward.

revoke execute on all functions in schema public from public, anon;

grant execute on function
  is_creator(uuid, uuid),
  has_owner_grant(uuid, uuid),
  is_owner(uuid, uuid),
  is_approved_member(uuid, uuid),
  has_buyer_grant(uuid, uuid),
  is_site_member(uuid, uuid),
  can_access_site(uuid, uuid, uuid),
  can_create_order_for_site(uuid, uuid, uuid),
  can_purchase_for_site(uuid, uuid, uuid),
  can_act_as_driver(uuid, uuid),
  _current_display_name(),
  create_order(uuid, uuid, text, text, text, numeric, text, text, double precision, double precision, text, text, text, text, text, numeric),
  edit_order(uuid, integer, numeric, uuid, text),
  approve_order(uuid),
  reject_order(uuid, text),
  revert_approval(uuid),
  start_purchase(uuid),
  abandon_purchase(uuid),
  complete_purchase(uuid),
  claim_delivery(uuid),
  cancel_delivery(uuid, text),
  mark_collected(uuid),
  mark_delivered(uuid, timestamptz, text),
  cancel_order_direct(uuid, text),
  request_cancellation(uuid, text),
  decide_cancellation_request(uuid, cancellation_request_status, text)
to authenticated;
