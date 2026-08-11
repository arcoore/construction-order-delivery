# CLAUDE.md — SiteStock project instructions

Read this before making changes. It's the durable reference: what this project is, how it's built, and the rules that keep it coherent. For "what's done / what's next right now," see [PROGRESS.md](PROGRESS.md) instead — that file changes often, this one shouldn't.

## What this is

A construction-firm ordering & delivery prototype ("SiteStock"). A **Worker** on site searches a materials catalog and requests an order; the community **Owner** approves or rejects it; an approved **Driver** picks it up from the nearest/chosen stockist and delivers it. Communities work like Discord servers — an Owner creates one, Workers/Drivers join it (by browsing or invite code, subject to Owner approval) — and everything (orders, requests, roles) is scoped to one community at a time.

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
- `public/js/store.js` — order CRUD (`getOrders`, `addOrder`, `updateOrder`, `subscribe`)
- `public/js/community.js` — communities, membership, join requests, owner grants, active community/role/identity session state
- `public/js/auth.js` — accounts (username/password/displayName/defaultRole), login/logout/skip session
- `public/js/data.js` — static mock catalog (products, stockist branches) + pure helpers (`searchProducts`, `formatPrice`, `getInitials`, `getCategoryIcon`, `getAvailability`)
- `public/js/geo.js` — UK postcode geocoding via postcodes.io (free, keyless) + haversine distance + browser geolocation

**UI layer** (owns a chunk of DOM, renders from data-layer state, wires its own event listeners):
- `public/js/authView.js` — the login/register/skip screen
- `public/js/communityView.js` — the Communities management screen (create/join-by-code/browse/your-communities/pending-requests)
- `public/js/site.js` — Worker view (search → size → details → source → confirm → order history)
- `public/js/owner.js` — Owner view (dashboard stats, activity feed, Team/grant panel, join-request approval, order approval tabs)
- `public/js/driver.js` — Driver view (location, Requests/My Deliveries/Completed tabs)

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
              → worker-view | owner-view | driver-view
      → profile-view (account details + community memberships + log out)
```

**Role resolution has no per-visit prompt for real accounts.** At signup, an account answers "worker/driver/owner" once (`account.defaultRole`). Entering any community calls `resolveEntryRole(communityId, name, preferredRole)` (`community.js`):
1. If they're actually the Owner here (creator, or granted — see below) → straight to `owner-view`, no matter what they picked at signup.
2. Else if their `defaultRole` is worker/driver and they're an approved member → straight there.
3. Else (e.g. picked "owner" but isn't this community's owner) → falls back to `worker-view`.

`role-select-view` ("Choose your role") is now only reached as a **fallback** — for the "Skip for now" path (no account, so no stored preference) or legacy accounts with no `defaultRole`. Don't remove it; it's load-bearing for that path.

### Owner permission model

- `isCreator(communityId, name)` — true only for whoever's name matches `community.ownerName` (set once at creation, never changes).
- `hasOwnerGrant(communityId, name)` — true if the creator has explicitly granted this person owner access (stored in `sitestock_owner_grants_v1`).
- `isOwner(communityId, name)` = `isCreator(...) || hasOwnerGrant(...)`. This is the function almost everything else should call — `isCreator` is only for gating the "Team" grant/revoke UI itself (only the true creator can grant/revoke; a granted owner cannot grant further).
- Granting fires a one-time "You've been upgraded to owner level" popup for the *recipient's* browser session, tracked via `sitestock_seen_grants_v1` so it never repeats (see `findUnseenGrantFor`/`markGrantSeen` in `community.js`, wired in `main.js`'s `checkForNewOwnerGrant`).

### Order lifecycle

```
pending_approval  →  pending  →  accepted  →  picked_up  →  delivered
        ↓ (owner rejects, with optional reason)
    rejected
```

- Worker's `site.js` creates an order at `pending_approval` after they've walked through search → size → quantity/postcode → **choose which stockist to buy from** (worker picks the source, not the driver — driver just fulfills it) → confirm.
- Owner approves (→ `pending`, now visible to drivers) or rejects (→ `rejected`, reason optional, visible back to the worker).
- Any `pending`/`accepted` order can be **reverted** back to `pending_approval` by the owner within a 72-hour window of the approve/reject decision — countdown shown live, computed from `approvedAt`/`rejectedAt`, not a real scheduled job. Locks permanently once the driver marks it `picked_up` (physical handoff already happened, can't be undone).
- Driver actions (`accept`/`picked_up`/`delivered`) live in `driver.js`; owner actions (`approve`/`reject`/`revert`) live in `owner.js`. Both call `store.js`'s `updateOrder`.

### Data shapes (informal — no schema/types, just what's actually written)

**Order** (`sitestock_orders_v1`, via `store.js`): `id, communityId, productId, productName, variant, quantity, unit, deliveryPostcode, deliveryLat, deliveryLon, requestedBy, status, createdAt, driver, stockistId, stockistName, stockistWebsite, stockistPostcode, pickupEstimate, unitPrice, totalPrice, approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionReason, acceptedAt, pickedUpAt, deliveredAt`.

**Community** (`sitestock_communities_v1`): `id, name, code (6-char invite code), ownerName, createdAt`.

**Join request** (`sitestock_join_requests_v1`): `id, communityId, name, status (pending/approved/declined), requestedAt, decidedAt, decidedBy`.

**Owner grant** (`sitestock_owner_grants_v1`): `id, communityId, name, grantedBy, grantedAt`.

**Account** (`sitestock_accounts_v1`): `id, username, password (plaintext — see Security note), displayName, defaultRole (worker/driver/owner), createdAt`.

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
