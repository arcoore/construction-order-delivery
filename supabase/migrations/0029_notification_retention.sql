-- Notification retention (product-audit gap fix).
--
-- The notifications table previously only ever grew — nothing pruned it.
-- Policy: delete notifications that are BOTH read AND older than 90 days.
-- Unread notifications are never pruned regardless of age (the recipient
-- hasn't dealt with them yet); recent read ones are kept so "mark as
-- unread" and the recent history still work. This is deliberately
-- conservative — it removes only what a user has already seen and had
-- months to revisit.
--
-- Scheduling uses pg_cron. On the local stack the extension is available
-- and created here directly. On hosted Supabase, if pg_cron isn't already
-- enabled the CREATE EXTENSION line will fail this migration — enable
-- pg_cron in the dashboard (Database → Extensions) first, then re-run.
-- prune_notifications() itself is independent of the scheduler and can be
-- called manually at any time.

create or replace function prune_notifications()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from notifications
  where read = true
    and read_at is not null
    and read_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Not granting EXECUTE to authenticated/anon — this is a maintenance
-- function, run by the scheduler (as the postgres/cron role) or manually by
-- an admin, never from the client.
revoke execute on function prune_notifications() from public, anon, authenticated;

create extension if not exists pg_cron;

-- cron.schedule is idempotent by job name — re-running this migration
-- replaces the schedule rather than duplicating it. 03:17 daily, an
-- arbitrary quiet hour.
select cron.schedule('prune-read-notifications', '17 3 * * *', 'select prune_notifications();');
