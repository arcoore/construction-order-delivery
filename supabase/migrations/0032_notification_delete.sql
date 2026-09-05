-- Let a recipient delete their own notifications (product-audit gap fix —
-- finishes the notification-management story alongside 0029's retention
-- prune).
--
-- Until now a recipient could mark a notification read/unread but never get
-- rid of one — the panel only ever grew (bounded by 0029's 90-day prune of
-- READ notifications, but an unread pile or a <90-day read pile still can't
-- be cleared by hand). Each notifications row is already scoped to exactly
-- one user by recipient_user_id (it's that user's private copy of a
-- system-generated signal, never shared state), so a self-delete is
-- harmless: it removes only the caller's own row and affects no one else.
--
-- Creation is still server-only (no INSERT grant — unchanged); this only
-- adds DELETE, scoped exactly like the existing select/update policies.

grant delete on notifications to authenticated;

create policy notifications_delete_own on notifications
  for delete to authenticated
  using (recipient_user_id = auth.uid());
