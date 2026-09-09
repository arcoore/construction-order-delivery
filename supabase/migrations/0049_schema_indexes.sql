-- Targeted index top-up.
--
-- The schema was already well-indexed before this migration (~28 indexes):
-- every junction table has a UNIQUE composite that covers the permission
-- functions' point lookups (`community_memberships`/`owner_grants`/
-- `buyer_grants` on `(community_id, user_id)`, `site_memberships` on
-- `(site_id, user_id)`, `sites` on `(id, community_id)`), the order tables
-- carry `(community_id, status)` / `(order_id, created_at)` / pool /
-- driver indexes, and the frontend is almost entirely `select('*')` +
-- in-memory filter so most reads never hit a WHERE clause at all.
--
-- Three genuine gaps remained — each is a real query that today either
-- sorts a scanned set or filters a scan Postgres has no index to narrow.
-- This migration adds exactly those three and nothing speculative.
--
-- Local-only, unpushed — same as migrations 0024-0048. It ships to hosted
-- when the founder next runs a full deploy pass, not before.

-- ================================================================
-- 1. community_membership_events — the workforce audit trail.
--
-- public/js/community.js loads it with:
--     .eq('community_id', X).order('created_at', desc).limit(N)
-- 0023 gave the table `community_membership_events_community_idx
-- (community_id)`, which serves the equality but leaves Postgres to sort
-- every matching row on `created_at` for each page load. The table is
-- append-only and grows one row per membership status change forever, so
-- that sort only gets worse.
--
-- `(community_id, created_at desc)` serves the filter AND the ordered
-- LIMIT straight from the index with no sort step. It fully covers every
-- use of the plain `(community_id)` index (same leading column), so that
-- one is dropped rather than left as dead write-amplification on every
-- insert.
drop index if exists community_membership_events_community_idx;
create index community_membership_events_community_recent_idx
  on community_membership_events (community_id, created_at desc);

-- ================================================================
-- 2. feedback — the in-app "Send feedback" table (0048).
--
-- `_feedback_rate_guard()` runs on every insert:
--     select 1 from feedback
--     where user_id = new.user_id and created_at > now() - interval '20 seconds'
-- The only index today is `feedback_created_at_idx (created_at desc)`,
-- which does help the 20s window but still has Postgres re-check
-- `user_id` on each candidate row. `feedback` is deliberately NOT pruned
-- (0048: "feedback is signal worth keeping"), so it's the one guard table
-- that grows without bound.
--
-- `(user_id, created_at desc)` turns the per-user cooldown check into a
-- direct index probe. The global-cap check in the same trigger, and the
-- operator's dashboard reads, both keep using `feedback_created_at_idx`.
create index feedback_user_recent_idx
  on public.feedback (user_id, created_at desc);

-- ================================================================
-- 3. notifications — the prune job's supporting index.
--
-- `notifications` only ever grows during normal use; `prune_notifications()`
-- (0029) is the sole thing that shrinks it, once daily via pg_cron:
--     delete from notifications
--     where read = true and read_at is not null
--       and read_at < now() - interval '90 days'
-- `notifications_recipient_unread_idx` leads with `recipient_user_id`, so
-- it can't serve this predicate — the daily prune is a full table scan
-- that scales with total notification volume, not with the handful of
-- rows it actually deletes.
--
-- A partial index on `read_at`, restricted to the exact rows the prune can
-- ever touch (`read = true and read_at is not null`), stays small (unread
-- and never-read notifications are not indexed at all) and lets the delete
-- walk just the prunable tail. It does not affect any read path — those go
-- through the recipient index.
create index notifications_prunable_idx
  on notifications (read_at)
  where read = true and read_at is not null;
