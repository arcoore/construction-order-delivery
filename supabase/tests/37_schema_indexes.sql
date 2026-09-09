-- Targeted index top-up (migration 0049).
--
-- The project convention is that indexes are performance, not correctness,
-- and aren't unit-tested. This file is the one deliberate exception: 0049
-- DROPs an existing index (community_membership_events_community_idx) and
-- replaces it with a composite, and adds two more indexes that specific
-- trigger / cron queries depend on for scale. These assertions lock that
-- swap so a later "tidy up the indexes" pass can't silently undo it, and
-- they double as documentation of which query each index serves.
--
-- Checked against pg_indexes / pg_index directly rather than via pgTAP's
-- has_index(), whose 3-string overload means (table, index, column), not
-- (table, index, description) — an easy way to write a passing test that
-- checks the wrong thing.
begin;
select plan(8);

-- ---- 1. community_membership_events -----------------------------------
-- community.js: .eq('community_id', X).order('created_at', desc).limit(N)
select ok(
  exists (
    select 1 from pg_indexes
    where indexname = 'community_membership_events_community_recent_idx'
      and indexdef ilike '%(community_id, created_at%'
  ),
  'item 1: community_membership_events has the (community_id, created_at desc) composite');

select ok(
  not exists (
    select 1 from pg_indexes
    where indexname = 'community_membership_events_community_idx'
  ),
  'item 2: the now-redundant single-column community_membership_events_community_idx is dropped');

select ok(
  exists (
    select 1 from pg_indexes
    where indexname = 'community_membership_events_membership_idx'
  ),
  'item 3: the membership_id index (RLS join) is untouched');

-- ---- 2. feedback -----------------------------------------------------
-- _feedback_rate_guard(): where user_id = X and created_at > now() - 20s
select ok(
  exists (
    select 1 from pg_indexes
    where indexname = 'feedback_user_recent_idx'
      and indexdef ilike '%(user_id, created_at%'
  ),
  'item 4: feedback has the (user_id, created_at desc) per-user cooldown index');

select ok(
  exists (select 1 from pg_indexes where indexname = 'feedback_created_at_idx'),
  'item 5: feedback_created_at_idx (global cap + operator dashboard reads) is untouched');

-- ---- 3. notifications ----------------------------------------------
-- prune_notifications(): where read = true and read_at is not null
--                          and read_at < now() - interval '90 days'
select ok(
  exists (
    select 1 from pg_indexes
    where indexname = 'notifications_prunable_idx'
      and indexdef ilike '%read_at%'
  ),
  'item 6: notifications has the prune-support index on read_at');

select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'notifications_prunable_idx'
      and i.indpred is not null
  ),
  'item 7: notifications_prunable_idx is partial (indexes only the prunable tail, not every row)');

select ok(
  exists (select 1 from pg_indexes where indexname = 'notifications_recipient_unread_idx'),
  'item 8: notifications_recipient_unread_idx (the read path) is untouched');

select finish();
rollback;
