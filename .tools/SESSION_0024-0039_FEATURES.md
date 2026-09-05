# Session build log — migrations 0024–0039 (local only, unpushed)

Everything below was built in one session, committed **locally**, and is
**not on `origin/main` and not applied to hosted `sitestock-dev`**. Full
pgTAP suite: **33 files / 576 tests PASS**. `CLAUDE.md` / `PROGRESS.md` have
not been updated for any of this (they carry unrelated pending edits from a
prior session) — fold this in when convenient.

## Migrations

| # | What |
|---|---|
| 0024 | Stale-intent `statement_timeout` hardening (defense-in-depth; the real remaining fix is a Supabase pooler-config setting in the dashboard, not code — see PROGRESS.md "Known issues") |
| 0025 | `sites.project_start_date` / `project_end_date` |
| 0026 | `orders.delivery_method` (`driver` \| `direct_supplier`); `create_order` widened; new `confirm_direct_delivery` RPC; `claim_delivery` refuses direct-supplier orders |
| 0027 | `sites.site_contact_name` / `site_contact_phone` / `access_notes`; `sites.status` enum → text+CHECK (`active`/`paused`/`completed`/`archived`) |
| 0028 | `transfer_ownership` RPC (creator-only); `ownership_transferred` notification |
| 0029 | `prune_notifications()` + daily pg_cron job (read notifications > 90 days) |
| 0030 | **Multi-item orders** — `order_items` table; `orders.product_id/quantity/unit/unit_price` dropped; `create_order`/`edit_order` take `p_items jsonb`; `product_name`/`variant` kept as "+ N more" headline; `total_price` = server sum |
| 0031 | Site contact snapshot onto `orders` (so the driver sees it) |
| 0032 | `notifications_delete_own` — recipients can delete their own notifications |
| 0033 | **Site monthly budgets** — `sites.monthly_budget`; `orders_enforce_site_budget` BEFORE INSERT/UPDATE trigger (hard block; owner must raise the cap) |
| 0034 | **Value-threshold second approval** — `communities.approval_threshold`; `orders.needs_second_approval` + `second_approved_by*`; `approve_order` first/second routing (two different owners); `edit_order` recomputes; `revert_approval` clears both |
| 0035 | **Post-collection cancellation** — cancellation requestable at `collected`; approving cancels + notifies the driver to arrange the return; `delivered` still auto-closes |
| 0036 | **Partial fulfilment** — `order_items.delivered_short` + `shortfall_note`; `orders.fulfilment_status` (`full`/`partial`); `mark_delivered` gains `p_shortfalls jsonb` |
| 0037 | **In-app messaging** — `order_messages` table + `send_order_message` RPC; published to Realtime; `public/js/orderMessages.js` + `orderThreadView.js` |
| 0038 | **Permanent deletion** — `delete_site` (owner, no orders) / `delete_community` (creator, empty) RPCs |
| 0039 | **Photo proof of delivery** — private `delivery-photos` Storage bucket + `storage.objects` policies; `delivery_photos` table + `add_delivery_photo` RPC; `public/js/deliveryPhotos.js` + `deliveryPhotosView.js` |

## New frontend modules

- `public/js/orderMessages.js` / `orderThreadView.js` — per-order chat
- `public/js/deliveryPhotos.js` / `deliveryPhotosView.js` — delivery photos

## New pgTAP test files

`19`–`32` (site dates, delivery method, site contacts/status, ownership
transfer, notification retention, multi-item, site-contact snapshot, site
budgets, two-stage approval, post-collection cancellation, partial
fulfilment, order messages, permanent deletion, delivery photos).

## Realtime publication now has 12 tables

Added `order_messages` and `delivery_photos` (both community-scoped, both
want live updates). `realtime.js`'s community channel got listeners +
`refreshMessageCache` / `refreshPhotoCache`.

## Live-verified end to end (multi-role browser walkthrough)

Site budgets (hard block), two-stage approval (full UI: 1st owner button
disables, 2nd owner completes), messaging (worker↔owner, count on driver
card), partial fulfilment (driver deliver form → `fulfilment_status`),
photo proof (real upload as driver + signed URL; owner can read, not
upload — Storage RLS refuses), analytics panel. Zero console errors.

## Not done / deliberately deferred

- **Stale-intent idempotency** across lifecycle RPCs — `0024` did the
  code-side mitigation; the real fix is a pooler/PostgREST setting in the
  Supabase dashboard (per the founder's own call and the existing
  "Known issues" note), not a code change.
- **Deploy**: nothing pushed; migrations `0024`–`0039` not on hosted.
  That's the founder's go/no-go.
