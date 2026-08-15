-- Phase 8A — extensions and controlled-vocabulary types.
--
-- Split: the four values that ARE literal state machines (enforced almost
-- entirely by the RPC functions in 0010) become real Postgres enums, so an
-- invalid value is impossible at the type level. Notification type/category
-- and order-event type are CHECK-constrained text instead — these are more
-- descriptive/audit-log-shaped and have already grown once (Phase 7B added
-- three new event types and three new notification types without a status
-- machine changing at all), so a CHECK constraint that a later migration can
-- swap out is a better fit than an enum requiring ALTER TYPE ... ADD VALUE.

create extension if not exists pgcrypto; -- gen_random_uuid()

create type membership_status as enum ('pending', 'approved', 'declined');

create type site_status as enum ('active', 'archived');

create type order_status as enum (
  'pending_approval',
  'pending_purchase',
  'purchase_in_progress',
  'purchased',
  'claimed',
  'collected',
  'delivered',
  'rejected',
  'cancelled'
);

create type cancellation_request_status as enum ('pending', 'approved', 'rejected');
