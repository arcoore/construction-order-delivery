# CLAUDE.md — SiteStock project instructions

Read this before making changes. It's the durable reference: what this project is, how it's built, and the rules that keep it coherent. For "what's done / what's next right now," see [PROGRESS.md](PROGRESS.md) instead — that file changes often, this one shouldn't.

## What this is

A construction-firm ordering & delivery prototype ("SiteStock"). A **Worker** on site searches a materials catalog and requests an order; the community **Owner** approves or rejects it (if the community requires approval — configurable); a **Buyer** (owner-granted only) purchases it externally and confirms with a 3-second hold; an approved **Driver** claims it from the pool, collects it from the chosen stockist, and delivers it. Communities work like Discord servers — an Owner creates one, Workers/Drivers join it (by browsing or invite code, subject to Owner approval) — and everything (orders, requests, roles) is scoped to one community at a time.

This is a **prototype with no backend**. Every piece of data lives in the browser's `localStorage` on one device. There is no server, no database, no real network sync between users — "inviting" someone only works if they're using the same browser. This constraint has been confirmed with the user multiple times and is intentional for now; don't try to "fix" it by inventing a fake backend.

## Tech stack

- Plain HTML/CSS/JS. No framework, no build step, no bundler, no npm dependencies.
- JS is native ES modules (`<script type="module">`), loaded directly by the browser — no transpilation.
- All state persistence is `localStorage`, wrapped in small pub-sub data modules (see Architecture).
- Styling is one hand-written stylesheet, no CSS framework.

### Running it

Node is **not installed** on this machine — do not reach for it. The dev server is Python:

```bash
python "dev_server.py"
```

`dev_server.py` is a tiny custom static file server (stdlib `http.server`, no dependencies) that serves `public/` on port 3000 **with caching disabled** (`Cache-Control: no-store`). This replaced a plain `python -m http.server` after a real bug: the plain version served stale files after edits (browsers cache-validated against `Last-Modified` and got incorrect 304s within the same second as an edit). Always use `dev_server.py`, never the plain module.

`.claude/launch.json` is already wired to run this via the `preview_start` tool with name `"buyer-replacement"`. It has `"autoPort": true`, and `dev_server.py` reads `PORT` from the environment (falling back to 3000) — needed because this project sometimes gets opened in more than one chat session at once, and the second one can't bind port 3000. Don't hardcode port 3000 anywhere else; always let the tool tell you which port it actually started on.

### The Browser-pane screenshot tool

`computer{action:"screenshot"}` only works if the user has the Browser pane actually open/focused on their end (they click an "Open SiteStock..." affordance in their UI). If it times out with "the Browser pane is not displayed," that's not a bug to fix — just ask the user to open the pane and retry. Text-based verification (`get_page_text`, `javascript_tool`, `read_console_messages`) always works regardless and should be the default way to verify changes; reach for screenshots only when the user explicitly wants to *see* something visual.

## Architecture

### Three layers, by file

**Data layer** (no DOM access, pure state + localStorage + pub-sub):
- `public/js/store.js` — low-level order CRUD (`getOrders`, `addOrder`, `updateOrder`, `subscribe`). UI code must never call this directly for a lifecycle action — see `orderLifecycle.js`.
- `public/js/orderLifecycle.js` — the single guarded entry point for every order state change, plus the append-only order-event log. Also fans out notifications for the relevant events (see "Notification system" below). See "Order lifecycle" below.
- `public/js/community.js` — communities, membership, join requests, owner grants, buyer grants/requests, the per-community approval-required setting, active community/role session state (all keyed by user id — see `identity.js`). Buyer-role actions here also fan out notifications.
- `public/js/sites.js` — sites (job locations) within a community, site membership (who's assigned to which site), and the site permission composites (`canAccessSite`, `canCreateOrderForSite`, `canPurchaseForSite`). See "Site model" below. Not to be confused with `site.js` (singular) below, which is the Worker view — a pre-existing name that predates this module; see that section for why they coexist.
- `public/js/notifications.js` — the single storage/read-state owner for in-app notifications and notification preferences. See "Notification system" below.
- `public/js/auth.js` — accounts (username/password/displayName/defaultRole), login/logout/skip session
- `public/js/identity.js` — resolves "who is the current user" across real accounts and anonymous guest sessions; the only source of truth for permission-relevant identity (see "Identity model" below)
- `public/js/data.js` — static mock catalog (products, stockist branches) + pure helpers (`searchProducts`, `formatPrice`, `getInitials`, `getCategoryIcon`, `getAvailability`, `timeAgo`)
- `public/js/geo.js` — UK postcode geocoding via postcodes.io (free, keyless) + haversine distance + browser geolocation

**UI layer** (owns a chunk of DOM, renders from data-layer state, wires its own event listeners):
- `public/js/authView.js` — the login/register/skip screen
- `public/js/communityView.js` — the Communities management screen (create/join-by-code/browse/your-communities/pending-requests)
- `public/js/site.js` — Worker view (**select site** → search → size → details → source → confirm → order history). The filename predates the Phase 4A "Site" domain concept and still refers to the worker's job location in the loose everyday sense (`site-orders-list`, `renderSiteOrders`, etc.) — this was a deliberate decision (see PROGRESS.md Phase 4A) not to rename it, since there's no runtime collision with `sites.js`/`sitesView.js` (different files, different identifiers), only a naming-adjacency a reader should be aware of.
- `public/js/owner.js` — Owner view (dashboard stats, real event-log activity feed, Team/grant panel, join-request approval, buyer-request approval, approval-setting toggle, order approval tabs)
- `public/js/driver.js` — Driver view (location, Requests/My Deliveries/Completed tabs, claim/collect/deliver/cancel)
- `public/js/buyer.js` — Buyer view (list of orders awaiting purchase with full cost, review detail, press-and-hold-3s Purchased confirmation)
- `public/js/sitesView.js` — Sites management screen, owner-only (list active/archived sites, create, site detail with edit/archive/restore, employee assign/remove, per-site order list). See "Site model" below.

Each UI module exports a `refreshXView()` used by `main.js` to force a clean re-render when the user switches context (e.g. re-entering after switching community).

**Orchestrator**:
- `public/js/main.js` — the only module that knows about *all* the views. Owns `showOnly(view)` (toggles `.view.active` across every `<section>`), the topbar (community/profile pills, session bar, account dropdown), and all cross-cutting routing logic (`routeFromTop`, `enterCommunityFlow`, `showAuth/showCommunityPicker/showCommunitiesView/showProfile/showRoleSelect/showRoleView`). If you need to add a new top-level screen, it goes in `main.js`'s `ALL_VIEWS` array and gets a `showX()` function there — don't reinvent view-switching elsewhere.

Pattern to follow: data modules never touch the DOM; UI modules never read/write `localStorage` directly (they call data-module functions); `main.js` never renders content itself, only decides which section is visible and calls the UI modules' `refreshXView()`.

### Pub-sub convention

Every data module exposes `subscribeX(fn)`: adds `fn` to a listener set, **calls `fn()` immediately** on subscribe (so callers don't need a separate initial render), and re-calls every listener on any mutation. Cross-tab sync piggybacks on the native `storage` event (listed explicitly per-key in each module — if you add a new localStorage key to an existing module, add it to that module's `storage` listener too, or cross-tab/other-view updates silently stop working for it).

### View flow (who can reach what)

```
auth-view (login/register/skip)
  → community-view (front page: name + Log in/Show profile + Go to Communities)
      → communities-view (create / join-by-code / browse / your communities / pending requests)
          → role-select-view (fallback only — see below)
              → worker-view | owner-view | driver-view | buyer-view
                  → sites-view (owner-only, reached via the "Sites" topbar pill — see "Site model" below)
      → profile-view (account details + community memberships + buyer-access request + log out)
```

**Role resolution has no per-visit prompt for real accounts.** At signup, an account answers "worker/driver/owner" once (`account.defaultRole`). Entering any community calls `resolveEntryRole(communityId, userId, preferredRole)` (`community.js`):
1. If they're actually the Owner here (creator, or granted — see below) → straight to `owner-view`, no matter what they picked at signup.
2. Else if their `defaultRole` is worker/driver and they're an approved member → straight there.
3. Else (e.g. picked "owner" but isn't this community's owner) → falls back to `worker-view`.

`role-select-view` ("Choose your role") is now only reached as a **fallback** — for the "Skip for now" path (no account, so no stored preference) or legacy accounts with no `defaultRole`. Don't remove it; it's load-bearing for that path.

### Identity model

`identity.js` is the seam between real accounts (`auth.js`) and anonymous "Skip for now" sessions — every other module asks it "who is the current user" rather than touching identity state directly:
- `getCurrentUserId()` — a stable, unique id: `account.id` if logged in, otherwise a random guest id (`crypto.randomUUID()`) persisted per-browser in `sitestock_guest_id_v1`.
- `getCurrentDisplayName()` — the human-readable label: `account.displayName` if logged in, otherwise a guest's freely-editable name (stored in `sitestock_guest_names_v1`, keyed by guest id).
- `resolveDisplayName(userId)` — looks up any known account or guest id back into a readable name, for "current state" UI (community owner label, Team panel) rather than a historical snapshot.

**All permission/ownership checks in `community.js` and elsewhere are keyed by `userId`, never by display name.** This is deliberate: display names are cosmetic labels only, and typing an existing owner's name (in guest mode or anywhere else) can never grant their access — see the "Skip for now" note below. Order records (`store.js`) keep both: an `*Id` field for logic (`requestedById`, `driverId`, `approvedById`, `rejectedById`) and a parallel display-name string snapshot (`requestedBy`, `driver`, `approvedBy`, `rejectedBy`) taken at the time of the action, so historical order cards still read correctly even if a display name changes later.

**"Skip for now" / guest identity**: each browser gets one persistent guest id, generated on first skip and reused across visits. Renaming yourself as a guest only relabels that fixed id — it can never reassign someone else's community/order data. Logging out rotates the guest id **only if a guest was the one logging out** (`main.js`'s `sitestock:logout` handler checks `isGuest()` first) — logging out of a real account leaves any dormant guest identity in this browser untouched, since it was never the thing being signed out of. This means "log out, skip again" reliably gives a guest a genuinely fresh, unrelated identity, which is how this app now supports simulating different testers in one browser without any of them being able to hijack each other's access by typing a matching name.

### Owner permission model

- `isCreator(communityId, userId)` — true only for whoever's id matches `community.ownerId` (set once at creation, never changes).
- `hasOwnerGrant(communityId, userId)` — true if the creator has explicitly granted this user owner access (stored in `sitestock_owner_grants_v2`).
- `isOwner(communityId, userId)` = `isCreator(...) || hasOwnerGrant(...)`. This is the function almost everything else should call — `isCreator` is only for gating the "Team" grant/revoke UI itself (only the true creator can grant/revoke; a granted owner cannot grant further).
- Granting fires a one-time "You've been upgraded to owner level" popup for the *recipient's* browser session, tracked via `sitestock_seen_grants_v1` so it never repeats (see `findUnseenGrantFor`/`markGrantSeen` in `community.js`, wired in `main.js`'s `checkForNewOwnerGrant`).

### Buyer permission model

Unlike worker/driver (bundled free with approved membership), **buyer access is owner-granted only** — `isBuyer(communityId, userId)` = `hasBuyerGrant(...)`, mirroring the owner-grant shape exactly (`sitestock_buyer_grants_v1`). This is deliberate: buyer handles real purchasing/financial responsibility, so it shouldn't be automatic. Two ways in: an approved member requests it (`requestBuyerRole`, surfaced on the Profile screen), and any owner (not just the creator — this one isn't creator-restricted) approves/declines via the Team-adjacent "Buyer access requests" panel in `owner.js`; or an owner grants it directly from the Team panel without a request. `buyerRequestStatus(communityId, userId)` returns `'none' | 'pending' | 'granted'` for the Profile UI.

### Site model (Phase 4A)

A **Site** is an individual job location (e.g. "24 High Street") that belongs to exactly one community — a company can have many. Sites live in `sites.js`, following the exact same module shape as `community.js`: its own storage keys, its own pub-sub (`subscribeSites`), its own `storage`-event listener.

- **Storage**: `sitestock_sites_v1` (site records) and `sitestock_site_memberships_v1` (many-to-many join rows — a site can have any number of employees, an employee can belong to any number of sites; neither side ever assumes 1:1).
- **Ownership/CRUD**: `createSite`/`updateSite`/`archiveSite`/`restoreSite` are all owner-only (`isOwner(communityId, actorId)`, reused from `community.js` — not reinvented). No permanent delete — see the archive note below.
- **Membership**: `addSiteMember`/`removeSiteMember` are owner-only and require the target user to already be an approved community member (`isApprovedMember`) — site membership is a *further restriction inside* company membership, never a substitute for it.
- **Permission composites** — the only functions anything outside `sites.js` should use to decide "can this user do X with this site":
  - `canManageSite(communityId, userId)` — owner only.
  - `canAccessSite(siteId, communityId, userId)` — owner, or a member of that specific site.
  - `canCreateOrderForSite(siteId, communityId, userId)` — owner, or an approved community member who's *also* a member of that site.
  - `canPurchaseForSite(siteId, communityId, userId)` — owner, or a buyer who's *also* a member of that site.
  
  **Every one of these independently re-derives the site's real `communityId` and refuses if it doesn't match the `communityId` argument** (`siteBelongsToCommunity`, private) — `isSiteMember(siteId, userId)` alone only proves membership of a siteId, not that the site actually belongs to the community being checked against. This was a real gap caught during Phase 4A verification (a caller passing a mismatched `communityId` could otherwise let membership in one company's site satisfy a permission check scoped to a different company) and fixed at the module boundary rather than trusting every call site to pre-validate the pair — same "reference is not permission" discipline as the rest of this codebase. Always call these composites rather than reassembling the logic ad hoc, and always pass `communityId` explicitly — never infer it from `getActiveCommunityId()` inside a permission check, since a user can belong to multiple communities and the active one is session state, not a security boundary.
- **Drivers get no site permission function at all, on purpose.** A driver's access to site info is entirely mediated through order visibility (already gated by `isApprovedMember`, unrelated to sites) — they only ever see the site name/address/postcode/delivery-instructions *snapshot already sitting on an order they can already see*, never a live site record or the site's employee list.
- **Archiving, not deleting.** `status: 'active' | 'archived'` on the site record. Archiving only removes a site from the pickers used to start *new* orders (`getActiveSitesForUser`) — it never touches, blocks, or cancels any order already in flight; the order lifecycle is completely independent of live site status. No permanent-delete function exists.
- **Renaming a site never rewrites history.** Every order snapshots `siteName`/`siteAddress`/`sitePostcode`/`siteDeliveryInstructions` once at creation (see Order shape below) — editing or archiving the live site record afterward never changes how a past order reads.

### Order lifecycle

The order state machine and its append-only event log both live in `orderLifecycle.js` — **UI code must never call `store.js`'s `updateOrder` directly for a lifecycle action.** Every transition goes through a guarded function there (`approveOrder`, `rejectOrder`, `revertApproval`, `startPurchase`, `abandonPurchase`, `completePurchase`, `claimDelivery`, `collectDelivery`, `cancelDelivery`, `deliverOrder`), which re-reads the order fresh, checks the transition is legal from its *current* status (and, where relevant, that the actor is actually allowed — e.g. only the assigned driver can collect/cancel/deliver their own claim), applies the patch, and appends one or more events. An invalid call is refused with `{ ok: false, error }` regardless of what the UI happened to render — this is what makes invalid transitions structurally impossible, not just hidden.

```
pending_approval ──approve──▶ pending_purchase ──start_purchase──▶ purchase_in_progress
       │                            ▲  │                                  │
     reject                         │  └──revert (within 72h)─────────────┘
       ▼                            │                              complete_purchase │ abandon_purchase
   rejected ───revert (within 72h)──┘                                     ▼
                                                                       purchased ◀──────────────┐
                                                                           │ claim               │
                                                                           ▼                      │
                                                                       claimed ──cancel (reason)──┘
                                                                           │ collect
                                                                           ▼
                                                                       collected
                                                                           │ deliver
                                                                           ▼
                                                                       delivered
```

- Worker's `site.js` creates an order via `orderLifecycle.createOrder`, which starts it at `pending_approval` or `pending_purchase` depending on the community's `isApprovalRequired()` setting (toggle in `owner.js`, off by default *stays* off for existing orders — each order snapshots `approvalWasRequired` at creation so a later setting change never silently reinterprets it). `createOrder` also independently re-checks `canCreateOrderForSite(siteId, communityId, actorId)` (`sites.js`) before writing anything and refuses with `{ ok: false, error }` if it fails — this is a real data-layer check, not just a UI gate, so a worker can't create an order for a site they aren't assigned to no matter what got rendered. On success it snapshots the site's `name`/`address`/`postcode`/`deliveryInstructions` onto the order (see Order shape below). `startPurchase` has the equivalent check via `canPurchaseForSite`.
- Owner approves/rejects (`pending_approval` only). A decision can be **reverted** within a 72-hour window (`REVERT_WINDOW_MS`, exported from `orderLifecycle.js`) — but only if `approvalWasRequired` is true, and only while the order is still `pending_purchase`/`rejected`. The lock point is `purchased`, not `picked_up`/`collected` as in the old model — once a buyer has actually spent money, reverting the *approval* doesn't undo that, so it stops being offered.
- Buyer reviews (full cost visible), then must **press and hold "Purchased" for 3 real seconds** (`buyer.js`, `pointerdown`/`pointerup` driving `startPurchase`/`completePurchase`/`abandonPurchase`) — the hold is a confirmation that they already paid externally, not SiteStock processing anything. The hold itself is a real state (`purchase_in_progress`), which is what stops two buyers from both confirming the same order at once, exactly like driver claiming below.
- Driver claims (`purchased → claimed`, first fresh-read wins — this is also how the driver double-claim race is closed, safely within one browser: the guard always re-reads localStorage before writing, so a stale in-memory order object can never win a write), collects, then delivers. Delivering requires the driver to fill in **when** it was delivered (`deliveryTime`, a datetime-local input) and **where** (`deliveryLocation`, free text, pre-filled with the original delivery postcode but editable) before `orderLifecycle.js`'s `deliverOrder` will accept it — both are required at the data layer, not just the form. `deliveredAt` is recorded automatically alongside them (system timestamp of confirmation) and is deliberately kept distinct from the driver-reported `deliveryTime`, since they can differ (e.g. confirmed later due to no signal). No photo proof — deliberately out of scope. **Drivers never see `unitPrice`/`totalPrice`** — stripped from `driver.js`'s render entirely, not just unused.
- Driver can **cancel** a claimed (not yet collected) delivery — reason required, order returns to `purchased` (back in the pool), `driver`/`driverId` cleared on the order but preserved in the `delivery_cancelled` event's `meta` (since the order's own fields no longer have it) alongside `purchasedById`, which is exactly what the `delivery_cancelled` notification (see below) uses to tell the buyer who dropped it and why.

### Notification system

`notifications.js` owns `sitestock_notifications_v1` (the notifications themselves) and `sitestock_notification_prefs_v1` (per-user preferences) — UI code must never touch either key directly, only this module's exported functions (`notifyUsers`, `getNotificationsFor`, `getUnreadCount`, `markRead`, `markUnread`, `markAllRead`, `getPreferences`, `savePreferences`, `subscribeNotifications`).

- **`recipientUserId` is the only field ever used to decide "is this mine."** Never a display name — this is the same rule identity.js established, applied here too. `actorName` is a cosmetic snapshot only, exactly like order events.
- **Recipients are computed by the callers** (`orderLifecycle.js`, `community.js`), using `community.js`'s own `getOwnerIds`/`getBuyerIds`/`approvedMembers` — `notifications.js` itself stays a leaf with zero permission logic, and the acting user is always excluded from their own notification's recipient list (no self-notifications).
- **Content is role-appropriate at generation time, not display time** — e.g. the `delivery_available` notification (driver pool) is generated with no price anywhere in its message string, because the string itself is what's stored; hiding a price later in some UI wouldn't un-leak a value already sitting in the record.
- **Preferences filter at creation time.** If a category (or one of the three delivery sub-switches — see below) is off for a recipient, the notification is simply never written for them. Turning the preference back on later does not retroactively create what was missed.
- **Mixed defaults within "Delivery updates" are why three types have their own sub-switch** (`deliveryAvailableEnabled`/`deliveryClaimedEnabled`/`deliveryCollectedEnabled`, all default `false`) separate from the category's own default (`true`) — `delivery_cancelled` and `order_delivered` just follow the category, the other three need their own flag because their sensible default disagrees with it.
- `buyer_access_granted`/`buyer_access_revoked` are **non-configurable** — they always fire regardless of preferences, since they directly affect the recipient's own permissions.
- **A notification never grants access.** Clicking one (`main.js`'s `navigateToNotification`) always re-checks `eligibleRoles` at click time before routing anywhere — if the stored `navigationTarget` points at a role the user no longer holds, it falls back to `routeFromTop()` instead of opening anything. The stored target is a wish, never an authority.
- Opening a notification auto-marks it read; manually toggling back to unread is always available. "Mark all as read" and the unread badge are both scoped to `recipientUserId === currentUserId` — trivially correct since every query is already filtered that way before either ever sees the list.
- The unread badge/panel are **global across all the user's communities**, not scoped to the active one.
- No polling anywhere — creation happens synchronously in the same call as the state change that caused it; cross-tab sync piggybacks on the native `storage` event, same as every other module here.
- **Known future consideration, not yet solved:** `sitestock_notifications_v1` only ever grows, and `localStorage` has real size limits (~5–10MB). No pruning/capping exists yet — flagged here so it doesn't silently become a problem, not something to fix without being asked.

### Data shapes (informal — no schema/types, just what's actually written)

**Order** (`sitestock_orders_v4`, via `store.js`): `id, communityId, siteId, siteName, siteAddress, sitePostcode, siteDeliveryInstructions, productId, productName, variant, quantity, unit, deliveryPostcode, deliveryLat, deliveryLon, requestedBy, requestedById, status, createdAt, approvalWasRequired, driver, driverId, claimedAt, collectedAt, deliveredAt, deliveryTime, deliveryLocation, stockistId, stockistName, stockistWebsite, stockistPostcode, pickupEstimate, unitPrice, totalPrice, approvedBy, approvedById, approvedAt, rejectedBy, rejectedById, rejectedAt, rejectionReason, purchaseStartedBy, purchaseStartedById, purchaseStartedAt, purchasedBy, purchasedById, purchasedAt, cancelledBy, cancelledById, cancelledAt, cancellationReason`. The non-`Id` actor fields are display-name snapshots for rendering only — never used for permission checks; `siteName`/`siteAddress`/`sitePostcode`/`siteDeliveryInstructions` follow the exact same convention (a point-in-time snapshot of the `sites.js` record at creation, alongside the logic-bearing `siteId` — see "Site model" above for why). `deliveryTime`/`deliveryLocation` are driver-reported (Phase 2B); `deliveredAt` is the automatic system timestamp of confirmation — kept distinct on purpose. Only ever written via `orderLifecycle.js`, never directly.

**Order event** (`sitestock_order_events_v1`, via `orderLifecycle.js`, append-only — no update/delete is exported): `id, orderId, communityId, type, actorId, actorName, fromStatus, toStatus, reason, meta, createdAt`. Event types: `order_created, approved, rejected, approval_reverted, purchase_started, purchase_abandoned, purchased, delivery_claimed, delivery_cancelled, delivery_returned_to_pool, collected, delivered`. This is the real audit trail — `owner.js`'s dashboard activity feed queries it directly rather than reconstructing history from order fields, so a revert no longer erases the events that led up to it.

**Community** (`sitestock_communities_v2`): `id, name, code (6-char invite code), ownerId, createdAt, requireOwnerApproval` (boolean, additive field — missing/undefined means `true`, no version bump needed for it).

**Join request** (`sitestock_join_requests_v2`): `id, communityId, userId, status (pending/approved/declined), requestedAt, decidedAt, decidedById`.

**Owner grant** (`sitestock_owner_grants_v2`): `id, communityId, userId, grantedById, grantedAt`.

**Buyer grant** (`sitestock_buyer_grants_v1`): `id, communityId, userId, grantedById, grantedAt`. Same shape as owner grant.

**Buyer request** (`sitestock_buyer_requests_v1`): `id, communityId, userId, status (pending/approved/declined), requestedAt, decidedAt, decidedById`. Same shape as join request; approving one also creates the corresponding buyer grant.

**Site** (`sitestock_sites_v1`, via `sites.js`): `id, communityId, name, address, postcode, deliveryInstructions, status ('active'/'archived'), createdAt, createdById, createdBy, updatedAt, archivedAt, archivedById, archivedBy`. `id` is a stable generated id, never derived from or dependent on `name` — two sites (same or different communities) can share a name with zero ambiguity. `archivedAt`/`archivedById`/`archivedBy` are null until archived.

**Site membership** (`sitestock_site_memberships_v1`, via `sites.js`): `id, siteId, communityId, userId, addedAt, addedById, addedBy`. A plain many-to-many join row — a site can have any number of members, a user can belong to any number of sites in any number of communities. `communityId` is denormalized from the site record purely as a defense-in-depth check inside the permission composites (see "Site model" above), not as a second source of truth.

**Account** (`sitestock_accounts_v1`): `id, username, password (plaintext — see Security note), displayName, defaultRole (worker/driver/buyer/owner), createdAt`.

**Notification** (`sitestock_notifications_v1`, via `notifications.js`): `id, recipientUserId, type, category, title, message, communityId, orderId, requestId, eventId, actorId, actorName, navigationTarget, createdAt, read, readAt`. Only `read`/`readAt` are ever mutated after creation — everything else is write-once, same as an order event. Types: `order_awaiting_approval, order_rejected, approval_reverted, order_ready_for_purchase, delivery_available, delivery_claimed, delivery_cancelled, delivery_collected, order_delivered, buyer_access_requested, buyer_access_granted, buyer_access_rejected, buyer_access_revoked`.

**Notification preferences** (`sitestock_notification_prefs_v1`, via `notifications.js`): `userId, orderUpdates, approvalUpdates, deliveryUpdates, roleUpdates, deliveryAvailableEnabled, deliveryClaimedEnabled, deliveryCollectedEnabled, updatedAt`. No record = all four category presets `true`, all three sub-switches `false` (see "Notification system" above for why the sub-switches exist).

*(The `_v2` bump on communities/join-requests/owner-grants reflects the switch from name-string identity to `userId`-based identity. The `_v3` bump on orders reflects the Phase 2A lifecycle rework — renamed statuses and new fields. The `_v4` bump on orders reflects Phase 4A — `siteId` and its snapshot fields became permanent, required parts of the order shape rather than an optional add-on, so every order now has a real site behind it with no "legacy/unassigned site" branching needed anywhere. In all cases old data was intentionally discarded, not migrated, per explicit direction each time — there was nothing reliable to migrate from. `sitestock_sites_v1`/`sitestock_site_memberships_v1` are brand-new keys, not a bump of anything.)*

Mock catalog (`data.js`): 16 products across categories (Timber, Building Materials, PPE, Plumbing, Tools, etc.), each with a `unitPrice`, a list of `variants` (size/type — every product has at least one, so the "pick material → pick size" flow never skips a step), and `branchIds` referencing 12 mock UK builders'-merchant branches (name, website domain, postcode, lat/lon). Availability estimates (`getAvailability`) and category icons are deterministic mock data, not real inventory.

## Conventions

- **No comments unless the *why* is non-obvious.** This codebase mostly follows that; keep doing so.
- **Avatars/initials**: always via `getInitials(name)` from `data.js` — single shared implementation, don't reinvent per-file.
- **Relative time**: `timeAgo(ts)` lives in `data.js` alongside `formatPrice`/`getInitials` — import it from there, don't redefine it locally (it used to be duplicated in `communityView.js` and `owner.js`; that's been consolidated).
- **Prices**: always `formatPrice()` from `data.js` (`£X.XX`), never hand-rolled.
- **CSS**: one file, `public/css/style.css`, organized roughly in the order features were built rather than by component — search before adding a new rule, there's likely a close existing pattern (stat tiles, pill buttons, card lists, modal overlay, role-toggle groups, etc.) to extend rather than duplicate.
- **`[hidden]` vs custom CSS display rules**: if you give an element `display: flex/grid/block` in CSS, you **must** also add `.your-class[hidden] { display: none; }` — a plain class rule of equal specificity beats the browser's default `[hidden]` rule and the element stays visible. This has bitten us once already (the session-bar pill leaking onto the login screen); check for it whenever adding `hidden`-toggled elements with non-default `display`.
- **Testing changes**: this app is entirely click-flow-driven with no automated tests. Verify with the Browser pane tools (`javascript_tool` to drive clicks/form-fills, `get_page_text`/`read_console_messages` to confirm) rather than assuming. Screenshots are a nice-to-have on top, not the primary verification method (see note above).

## Security note (be upfront about this, don't paper over it)

Passwords are stored in **plaintext** in `localStorage`. There is no hashing, no backend, no real auth. This has been explicitly flagged to the user in the UI copy on the login screen and confirmed as acceptable for now ("don't reuse a real password here"). Do not present this as secure. Do not add fake/theatrical "encryption" that isn't real encryption. When the user is ready for a real backend, that's the point to add real password hashing — not before.

## Things NOT to do without asking

- Don't reach for Node/npm — it isn't installed here.
- Don't "fix" the single-browser/no-sync limitation by inventing a fake backend or fake cross-device sync — it's a known, accepted constraint.
- Don't remove `role-select-view` or its fallback logic — it's the only path for skipped/no-account users.
- Don't add real password hashing/security theater without the user asking for the actual backend step.
- Don't call `store.js`'s `updateOrder` directly from UI code for a lifecycle action — always go through `orderLifecycle.js`'s guarded functions, or the state-machine/event-log guarantees silently stop holding.
- Don't decide site access by checking `isSiteMember`/role checks separately and combining them ad hoc — always call `sites.js`'s `canAccessSite`/`canCreateOrderForSite`/`canPurchaseForSite` composites, which already handle the owner bypass and the cross-community `communityId` cross-check correctly in one place.
