# SiteStock backend foundation (Phase 8A / 8B / 8C)

**Status: identity, companies (communities), sites, orders, order events, and cancellation requests are all now Supabase-backed and locally verified end-to-end through the real frontend (Phase 8B + Phase 8C). Only in-app notifications and notification preferences are still `localStorage`-only — see "Phase 8C — order lifecycle migration" below for exactly what moved this phase and what's still local. No cloud/production Supabase project exists yet — everything below runs against the local Supabase CLI dev stack only.**

## What this is

This directory is the Postgres/Supabase backend designed in the Phase 8 architecture document and built in Phase 8A, then wired to `public/` in two stages: Phase 8B (identity/companies/sites) and Phase 8C (orders/order events/cancellation requests). `public/` is **not** fully migrated — notifications remain local — see the Phase 8C section below for the exact remaining hybrid boundary.

## Layout

```
supabase/
  config.toml                          — minimal Supabase CLI project config
  migrations/                          — schema, in numbered, applied-in-order files
    0001_extensions_and_types.sql      — pgcrypto, the four core state-machine enums
    0002_profiles.sql                  — profiles table + auth.users → profiles trigger
    0003_communities_and_membership.sql — communities, memberships, owner/buyer grants+requests
    0004_sites.sql                     — sites, site_memberships (composite FK cross-community guard)
    0005_orders_and_events.sql         — orders, order_events
    0006_cancellation_requests.sql     — cancellation_requests (partial-unique "one pending" constraint)
    0007_notifications.sql             — notifications, notification_preferences (schema only, unwired)
    0008_permission_functions.sql      — is_owner / is_approved_member / can_access_site / etc.
    0009_rls_policies.sql              — every table's RLS policies, explicit per action
    0010_order_lifecycle_functions.sql — every order-lifecycle RPC function
    0011_grants.sql                     — explicit authenticated GRANTs (table + RPC EXECUTE)
    0012_widen_edit_order.sql          — Phase 8C: widened edit_order RPC (full field set, server-computed total_price)
  tests/                                — pgTAP tests, one concern per file
    00_helpers.sql                     — tests.create_user() / tests.authenticate_as()
    01_isolation_and_permissions.sql   — cross-company isolation, site/buyer permissions
    02_order_lifecycle_and_races.sql   — unauthorized actions, claim/purchase races, cancellation race
    03_notification_isolation.sql      — notification recipient isolation
    04_edit_order_and_widening.sql     — Phase 8C: edit_order authorization, pricing, reapproval, stale-version conflict
```

## How to actually run this

**Option A — local Supabase CLI dev stack (this is what Phase 8A.5 actually used):**
1. Install Docker Desktop (with WSL2 as the backend on Windows).
2. Install the Supabase CLI.
3. From the repo root: `supabase start` (spins up local Postgres + Auth + a Studio UI).
4. `supabase db reset` applies every file in `migrations/` in order against the local instance.
5. `supabase test db` runs every file in `tests/` via pgTAP and reports pass/fail.

**Option B — a real (free-tier) Supabase cloud project**, per the approved architecture (London/eu-west-2 region if available): create the project via supabase.com, then `supabase link` and `supabase db push` to apply the migrations. Running the pgTAP tests against a cloud project requires the `pgtap` extension enabled on that project (Supabase supports this) and a connection string passed to `pg_prove` or `supabase test db --linked`. **This option has not been done — no cloud/production Supabase project has been created for this app.**

## What has and hasn't been verified (Phase 8A.5)

Docker Desktop and WSL were successfully configured in this environment, and the Supabase CLI (v2.114.0) was used to bring up a real local Postgres stack via `supabase start`. Against that stack:

- All 11 migrations in `migrations/` apply cleanly, in order, from a completely empty database — re-tested across multiple full `supabase db reset` cycles, not just once.
- The pgTAP suite (`tests/`) now contains 37 tests across the 4 files. `supabase test db` reports **37/37 passing, 0 failed, 0 skipped**.
- 10 critical security checks passed, including confirming RLS is enabled on all 13 intended tables (every table created across `migrations/0002`–`0007`) and that no table is left with RLS off by omission.
- The order-lifecycle RPC functions (`create_order`, `approve_order`, `claim_delivery`, etc.) were exercised directly against the real local Postgres, not just reviewed for internal consistency.
- A genuine concurrent-race test was run for the driver-claim path specifically: two separate database connections both attempted `claim_delivery` on the same order at the same time, and exactly one succeeded — confirming the same first-fresh-read-wins guarantee `orderLifecycle.js` already provides client-side. The other race scenarios described in the architecture (double-purchase, cancellation-vs-collection) are covered by the pgTAP suite's sequential assertions but were **not** independently re-run as genuine simultaneous multi-connection races the way the driver-claim one was — worth doing before leaning on that guarantee for anything real.

None of this connects to the live frontend. `public/` was not touched or migrated in any way — the app still runs entirely on `localStorage`, unchanged. Phase 8B (actually wiring `public/` to this backend) has not started.

### Fixes required to get from "designed" to "verified"

Three real bugs were only found by actually running this against Postgres, not by review:

- **`sites` SELECT RLS policy self-reference** — see the comment above `sites_select` in `migrations/0009_rls_policies.sql`. Using `can_access_site()` here caused `INSERT ... RETURNING` on `sites` to spuriously fail, because Postgres re-evaluates the SELECT policy against the just-written row in the same statement, and `can_access_site`'s own re-query of `sites` doesn't see it yet. Fixed by checking the row's own columns directly instead of re-querying the table.
- **Missing explicit `authenticated` table grants** — RLS policies alone don't grant access; Postgres also needs the underlying table-level `GRANT`. Added explicitly per table in `migrations/0009_rls_policies.sql`, plus a dedicated `migrations/0011_grants.sql` for `EXECUTE` on every RPC function (revoking the PUBLIC/anon default, since guest mode has no place in this backend).
- **pgTAP auth helpers/test fixtures** — `tests/00_helpers.sql`'s `authenticate_as`/`clear_authentication` originally tried to set the `role` GUC from inside a `SECURITY DEFINER` function, which Postgres explicitly forbids. Also, switching identity a second time within one test file broke because `authenticated` never had `USAGE` on the `tests` schema. Both fixed — see the comments in that file for the detail.

## Phase 8B — frontend wiring (hybrid)

`public/` now talks to this local Supabase stack for **authentication, profiles, communities, community memberships, owner grants, buyer grants, buyer requests, sites, and site memberships**. `public/js/supabaseClient.js` is the only place the Supabase JS client is instantiated (loaded as a plain ES module from `esm.sh` — no bundler in this project, see CLAUDE.md), using the local stack's well-known dev anon key.

**Still `localStorage`-only, unchanged this phase**: orders, order events, cancellation requests, notifications, notification preferences, plus two UI-only pointers (active community id, active role) that were never meant to be shared data in the first place. **Don't read this as "SiteStock is multi-device now" — it's specifically the identity/company/site layer that is; a worker's placed orders still only exist in the browser that created them until Phase 8C.**

### Why "sync facade over an async cache," not a full async rewrite

`orderLifecycle.js` and the owner/buyer/driver/site UI modules call `isOwner`/`isApprovedMember`/`isBuyer`/`canAccessSite`/`canCreateOrderForSite`/`canPurchaseForSite`/`getCurrentUserId`/`resolveDisplayName`/etc. **synchronously, inline, inside render code** (33 call sites across `owner.js`/`buyer.js`/`driver.js`/`site.js` alone) — those four files were deliberately kept out of scope for Phase 8B. A real Supabase call is asynchronous, so something has to bridge the gap. The answer: `identity.js`/`community.js`/`sites.js` do real async Supabase I/O internally, populate an in-memory cache, and keep exposing the exact same synchronous read functions as before, reading from that cache. Every mutating function (`createCommunity`, `grantBuyerAccess`, `addSiteMember`, etc.) is genuinely `async` and refreshes the cache from the server's own response before resolving.

**The cache is never the authorization boundary — RLS is.** A stale cache can at worst show a UI affordance a user is no longer entitled to use; clicking it triggers a real Supabase write that RLS independently re-checks and refuses if it should. This was verified directly (see "What was tested" below): four different direct unauthorized-write attempts against the raw Supabase client (self-granting owner access, self-adding as a site member, a raw `orders` table insert, self-approving a nonexistent membership) were all refused by RLS regardless of what any client-side cache said.

### Cache lifecycle (read before touching `identity.js`/`community.js`/`sites.js`)

- **Refresh on login/logout**: `community.js`/`sites.js` each call `subscribeAuth(() => refresh...Cache())` internally — every real auth transition triggers a refetch automatically.
- **Refresh after every write**: every mutating function updates the in-memory cache from the server's own returned row (or a scoped refetch) before resolving its promise — never an optimistic local guess.
- **Explicit async bootstrap**: `main.js` awaits `authReady` (session restore) and an initial full cache load before the very first `routeFromTop()` call — nothing ever renders a role view off an empty/uninitialized cache. `index.html`'s `#bootstrap-loading` panel covers the screen the whole time.
- **Refetch on view entry**: `main.js`'s routing functions (`showRoleView`, `showRoleSelect`, `enterCommunityFlow`, `showCommunitiesView`, `showSitesView`, `showProfile`) each `await` a community/site cache refresh before rendering — this is `main.js` orchestrating the sequencing from outside the four excluded files, not those files being made async themselves.
- **Refetch on window focus**: a lightweight `window.addEventListener('focus', ...)` refetch, since there's no Realtime subscription yet (deliberately deferred).
- **No Supabase Realtime this phase** — deliberate. Freshness comes entirely from the mechanisms above, which means `owner.js`/`buyer.js`/`driver.js`/`site.js` (which don't subscribe to community/site changes, only to order/cancellation-request changes) can show briefly stale community/site data if something changes in another session between their own render triggers — documented, accepted limitation, not silently swept under the rug.

### What was tested (Phase 8B, local stack)

- **Auth**: register, login, logout, session survives a full page reload, wrong password rejected, duplicate email rejected, duplicate display names allowed across different accounts, a legacy `localStorage` account (seeded manually) cannot authenticate (auth.js no longer reads that key at all).
- **Companies/sites, real UI, two real accounts**: Owner Alice registered, created a community, created a site; Worker Bob registered, requested to join by invite code, was approved by Alice, correctly saw the community and — after being assigned — the site, all through the unmodified `site.js`/`owner.js`/`sitesView.js` UI. Site edit/archive/restore verified through the real UI, including the archived-by display name resolving correctly from the profiles cache.
- **Buyer grant cache invalidation**: Alice granted Bob buyer access → Bob's session (after refresh) correctly saw `isBuyer` true; Alice revoked it → Bob's session (after refresh) correctly saw `isBuyer`/`canPurchaseForSite` false.
- **Site membership cache invalidation**: Alice removed Bob from the site → Bob's session (after refresh) correctly lost `canAccessSite`/`canCreateOrderForSite`/the site from his order-creation picker.
- **Cross-community fail-closed**: a real site id paired with a *wrong* community id (a community Alice does not own) correctly returned `false` from `canAccessSite`, even though Alice is a real owner elsewhere.
- **RLS security probes**: four direct unauthorized writes via the raw Supabase client (self owner-grant, self site-membership-add, raw `orders` insert, self-approving a membership) were all refused server-side.
- **Hybrid order compatibility**: a real order created via the unmodified `orderLifecycle.createOrder` correctly used the live Supabase auth UUID and real profile display name for `requestedById`/`requestedBy`, and a Supabase-backed `siteId` with its snapshot fields — no code changes were needed there.
- **Multi-session caveat, stated plainly**: this was verified via *sequential* login/logout cycles of two real accounts in one browser tool, not two genuinely simultaneous browser processes (the available tooling shares localStorage/session across tabs at the same origin, so a second tab inherits the first tab's session rather than acting as an independent device). The property that actually matters — a second identity, after establishing its own session, seeing data the first identity wrote to the real server — was proven; true concurrent-connection behavior for this slice was not separately re-verified the way Phase 8A.5's driver-claim race was for orders.
- Zero console errors observed from real app code across the whole pass (one stale/misleading `401` in the browser tool's own network-history buffer, traced and confirmed to be historical, not a live request — not a real bug).

### What's deliberately NOT done this phase

Orders/order events/cancellation requests/notifications migration (Phase 8C+), Supabase Realtime (currently poll-on-focus/view-entry instead), a production/cloud Supabase project, service-role usage anywhere in the frontend (only the anon key is ever shipped to the browser), and a `community` → `company` internal rename (user-facing wording only).

## Phase 8C — order lifecycle migration

**Status: complete, locally verified.** `public/js/orderLifecycle.js` was rewritten as a genuinely async facade backed by the real `orders`/`order_events`/`cancellation_requests` Postgres tables (already created in Phase 8A, unwired until now). The two standalone modules that used to own this data — `store.js` (low-level order CRUD) and `cancellationRequests.js` (the cancellation-request collection) — were both deleted; their responsibilities folded into `orderLifecycle.js`. A repo-wide grep confirms zero remaining references to either file or to the old `sitestock_orders_v4`/`sitestock_order_events_v1`/`sitestock_cancellation_requests_v1` localStorage keys.

### What changed in the backend itself

- **Migration `0012_widen_edit_order.sql`**: the Phase 8A `edit_order` RPC only accepted a narrow set of parameters. Widened to the full field set `site.js`'s Worker edit form actually needs (17 parameters — product/variant/quantity/unit/delivery details/site/stockist/pricing), added an `orders_unit_price_nonnegative` CHECK constraint, and added a "no changes made" guard the narrow version lacked. `total_price` is **never** a parameter — always computed server-side as `coalesce(p_unit_price, 0) * p_quantity`, so the browser cannot set it directly no matter what it sends. (Postgres function-overload gotcha hit and fixed here: `CREATE OR REPLACE FUNCTION` with a different parameter list creates a *second* overloaded function rather than replacing the first — the migration explicitly `DROP FUNCTION IF EXISTS`s the old narrow signature first.)
- **Optimistic concurrency (`version` column)**: every order gained an integer `version` column. Every write RPC takes `p_expected_version`, locks the row (`SELECT ... FOR UPDATE`), and raises `errcode = '40001'` (serialization_failure) if the real version has moved on since the client last read it — real database-level concurrency control, not the old client-side "re-read localStorage before writing" convention.
- **Pricing trust boundary, stated plainly**: `total_price` is server-computed and `unit_price` is server-validated as non-negative — but there is still no server-side product catalogue. `unit_price` itself is still supplied by the browser (from the `data.js` mock catalog) and is not independently verified against any supplier/catalogue source. This is a deliberate, documented limitation, not an oversight — building a real product catalogue or supplier API was explicitly out of scope this phase.
- **pgTAP tests (`tests/04_edit_order_and_widening.sql`, 9 new tests)**: unauthorized edit refused (`42501`), a successful edit correctly recomputes `total_price` server-side and increments `version`, a no-op edit is refused (`22023`), an edit to an already-approved order correctly forces reapproval (status → `pending_approval`, `approved_by_id` cleared, `approval_reverted` event logged), a stale-`version` edit is refused (`40001`), and a negative `unit_price` is rejected (`23514`). Full suite: **46/46 passing** (37 from Phase 8A.5 + 9 new). Two of the three originally-planned "race" tests turned out to already be covered by the existing `02_order_lifecycle_and_races.sql` suite (items 14 and 16) — documented in the test file's header rather than padding the count artificially.
- **Genuine multi-connection concurrency, beyond what pgTAP alone can prove**: pgTAP tests run inside a single transaction, which can't demonstrate a real simultaneous race. Two additional races were run via raw `docker exec ... psql` with two backgrounded connections and `pg_sleep` to force real overlap: a concurrent `start_purchase` race (two buyers, one order) and a concurrent `claim_delivery` race (two drivers, one order) — in both cases exactly one connection succeeded and the other was correctly refused with a stale-version conflict.

### Why write functions became async, but reads stayed synchronous

Same reasoning Phase 8B already established for `community.js`/`sites.js`: `orderLifecycle.js`'s **read** functions (`getOrders`, `getOrderEvents`, `getEventsForCommunity`, the cancellation-request reads) stay synchronous over an in-memory cache, because the four excluded UI files (`owner.js`/`buyer.js`/`driver.js`/`site.js`) still call reads inline inside render code. **Write** functions are different: Phase 8C made every one of them (`createOrder`, `editOrder`, `cancelOrderDirect`, `requestCancellation`, `decideCancellationRequest`, `approveOrder`, `rejectOrder`, `revertApproval`, `startPurchase`, `abandonPurchase`, `completePurchase`, `claimDelivery`, `collectDelivery`, `cancelDelivery`, `deliverOrder`) genuinely `async`, and every call site across all four UI files was updated to `await` them, with an in-flight guard (a disabled button or a module-level flag) around each one so a slow network can't produce a duplicate submission. This was a deliberate, explicitly-scoped decision for this phase — not an incidental change, and not license to make the read side async too.

**Actor identity is no longer passed in by the caller.** Every write function's signature dropped its old `actorId`/`actorName` parameters — the server derives the acting user from the real Supabase session (`auth.uid()`) inside the RPC, so passing (and trusting) a client-supplied actor id would have been misleading. `orderLifecycle.js` uses `identity.js`'s `getCurrentUserId()`/`getCurrentDisplayName()` directly wherever a notification needs the acting user's identity.

### Failure handling — stale/race refresh rule

`orderLifecycle.js`'s `handleRpcFailure(error, { orderId, requestId })` inspects the Postgres error code embedded in the RPC's response body (`error.code`, exposed by supabase-js regardless of the wrapping HTTP status) and refreshes the relevant cache slice on:
- `40001` (stale version / serialization failure) — refetches the specific order/request so the UI shows the real current state instead of the client's stale guess.
- `42704` (undefined/not found — e.g. the order was deleted or the id was never valid) — same refetch.
- `42501` (permission denied — e.g. a grant was revoked mid-session) — refetches the order/request **and** the community/site caches, since a permission failure here often means an owner/buyer grant or site membership changed underneath the user.

**A `40001` surfaces as HTTP `500`, not 409 — this is expected, not a bug.** PostgREST's default SQLSTATE-class-to-HTTP mapping puts the entire class `40` (Transaction Rollback, which includes `40001` serialization_failure) at `500`. This was directly observed during testing (a raw network-log entry showing `POST .../rpc/edit_order → 500 Internal Server Error` during a deliberate stale-version test) and traced to this exact PostgREST behavior — confirmed correct because `handleRpcFailure` keys off `error.code` from the response body, not the HTTP status, so the refresh logic fires correctly regardless of the misleading status label.

### Buyer hold-to-confirm, gated on real server confirmation

`buyer.js`'s press-and-hold purchase confirmation was rewritten as an explicit state machine (`idle → starting → holding → completing/abandoning → done`). The critical property: **the 3-second countdown never begins until `startPurchase` has actually round-tripped to the server and succeeded** — `begin()` `await`s the RPC before entering `holding`; a release requested while still `starting` is deferred and handled once the await resolves (never fired twice, never racing the in-flight request). Verified directly: a real `pointerdown`/`pointerup` cycle correctly drove `startPurchase` → real DB state `purchase_in_progress` (confirmed via direct `psql` query) → release correctly reverted to `pending_purchase`; a separate direct-call test confirmed `completePurchase()` correctly reaches `purchased` with the right total and notification fan-out. (Full natural 3-second auto-complete via synthetic pointer events was not directly observed end-to-end — a documented, pre-existing Browser-pane `requestAnimationFrame`-doesn't-fire-when-not-composited limitation, unrelated to Phase 8C's own correctness; the gating behavior that actually matters was proven via the methods above.)

### What was tested (Phase 8C, local stack)

- **Golden path**: worker creates → owner approves → buyer purchases (real hold-gated confirm) → driver claims/collects/delivers, all through the unmodified UI flow, all state and event-log entries correct at each step.
- **Genuine two-connection races**: concurrent `start_purchase` (two buyers) and concurrent `claim_delivery` (two drivers) on the same order — exactly one connection won each time, verified via raw multi-connection `psql`, not just pgTAP's sequential assertions.
- **Edit/reapproval**: editing an approved order correctly forces `pending_approval` and clears approval fields, preserving the original `approved` event; editing an unapproved order does not.
- **Cancellation**: direct cancel; cancellation-request → buyer approve; cancellation-request → buyer reject; a driver collecting the order before the buyer decides correctly auto-closes the request as rejected with a system-generated reason, leaving the order untouched at `collected`.
- **Stale-version conflict**: an edit against a stale `version` is refused with `40001` (observed as HTTP 500 per the PostgREST mapping above), and the UI correctly refreshes to the real current order state.
- **Live mid-session permission revocation**: a user's access was revoked while their screen was already open; the next write attempt was correctly refused server-side (RLS, not just a stale client cache), and the UI recovered via the `42501` refresh path.
- **Cross-company isolation**: re-confirmed for the newly-migrated order/event/cancellation-request data, matching the standard already set for identity/companies/sites in Phase 8B.
- **Regression sweep**: Owner tabs/detail/timeline, Driver Requests/My Deliveries/Completed tabs and zero-price rendering, Buyer cancellation-request panel, notification generation and click-through, login/default-role routing, session/bootstrap restoration after a fresh page load — all re-verified against the async rewrite and behave identically to before.
- **Console/network**: zero unexplained console errors across the full pass. The only two entries observed in the browser tool's cumulative error log were a stale-version-test `500` (explained above — expected, correctly handled, not a bug) and a `403` matching a deliberate permission-revocation/cross-company probe (expected refusal, not a bug).

### What's deliberately NOT done this phase

Notification migration (still local, unstarted), Supabase Realtime for orders (still poll-on-focus/view-entry, same as Phase 8B), a real server-side product/supplier catalogue (pricing input remains client-supplied, only the arithmetic is server-enforced — see the pricing trust boundary note above), and a production/cloud Supabase project.

## Security notes for whoever provisions the real project

- The **anon/public key** is safe to embed in frontend code later — that's how Supabase's model works, RLS is the real boundary, not key secrecy.
- The **service-role key** must never be pasted into chat, committed, or shipped to the browser. If manual SQL needs running against a real project before the CLI/migrations path is set up, do it through the Supabase dashboard's SQL editor while logged in as yourself, not by handing the service-role key to anyone or anything else.
- Enable the `pgtap` extension only on a development/test project, never assumed necessary on production.
