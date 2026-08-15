-- Notifications: schema only in Phase 8A — nothing writes to this table yet
-- (that's Phase 8D). recipient_user_id is the only field that ever decides
-- ownership, exactly matching the prototype's identity.js discipline;
-- actor_name is a cosmetic snapshot only, never used for permission or
-- routing decisions.
--
-- `type` includes the three cancellation-related values (cancellation_
-- requested/approved/rejected) that exist in the running Phase 7C product
-- but are missing from CLAUDE.md's own enumerated notification-types list —
-- a real doc-drift finding surfaced during this migration's design, not
-- something invented here.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references profiles (id),
  type text not null check (type in (
    'order_awaiting_approval', 'order_rejected', 'approval_reverted', 'order_ready_for_purchase',
    'delivery_available', 'delivery_claimed', 'delivery_cancelled', 'delivery_collected', 'order_delivered',
    'buyer_access_requested', 'buyer_access_granted', 'buyer_access_rejected', 'buyer_access_revoked',
    'site_member_added', 'site_member_removed', 'site_archived',
    'cancellation_requested', 'cancellation_approved', 'cancellation_rejected'
  )),
  category text not null check (category in (
    'orderUpdates', 'approvalUpdates', 'deliveryUpdates', 'roleUpdates'
  )),
  title text not null,
  message text not null,
  community_id uuid references communities (id),
  order_id uuid references orders (id) on delete set null,
  request_id uuid,
  event_id uuid references order_events (id) on delete set null,
  site_id uuid,
  actor_id uuid references profiles (id),
  actor_name text,
  navigation_target jsonb,
  created_at timestamptz not null default now(),
  read boolean not null default false,
  read_at timestamptz
);

create index notifications_recipient_unread_idx
  on notifications (recipient_user_id, read, created_at desc);

create table notification_preferences (
  user_id uuid primary key references profiles (id),
  order_updates boolean not null default true,
  approval_updates boolean not null default true,
  delivery_updates boolean not null default true,
  role_updates boolean not null default true,
  delivery_available_enabled boolean not null default false,
  delivery_claimed_enabled boolean not null default false,
  delivery_collected_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
