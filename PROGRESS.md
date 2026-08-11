# PROGRESS.md — SiteStock current state

Last updated: 2026-08-11 (later same day). This file tracks *what's actually true right now* — completed work, open issues, and next steps. For durable architecture/rules that don't change often, see [CLAUDE.md](CLAUDE.md) instead.

## Status: working prototype, actively iterating

Everything described below is built and has been manually verified in the browser (via `javascript_tool` click-throughs + `get_page_text`, and real screenshots once the user had the Browser pane open). No automated tests exist. No git repo exists yet either — this file is the only durable record between sessions.

## Completed features

### Core ordering flow
- Mock catalog search (materials/tools/PPE), two-step "pick material → pick size" flow with a "custom size" escape hatch, quantity + delivery postcode.
- Worker chooses *which stockist to buy from* (not the driver) — sees a list of carrying branches with a live-ish pickup-availability estimate, a confirm screen with a real link to that stockist's real homepage (not a fabricated deep link — explicitly scoped down from "give them an Amazon link" per user direction), then places the order.
- Driver view: browser geolocation (with manual-postcode fallback if denied), Requests/My Deliveries/Completed tabs, distance-sorted pickup list, accept → picked up → delivered.
- Pricing throughout (unit price + totals) — search results, confirm screen, order history, driver cards, owner dashboard total spend.

### Approval workflow
- Order status flow: `pending_approval → pending → accepted → picked_up → delivered`, with a `rejected` branch (optional reason).
- Owner approve/reject UI with inline reject-reason form.
- 72-hour revert window on approve/reject decisions, live countdown, locks permanently once `picked_up` (not just `delivered` — this was corrected mid-build after the user clarified "picked up from the supplier" is the real point of no return).
- Owner Dashboard: 6 stat tiles (members, pending join requests, awaiting approval, out for delivery, delivered, total spend) + a synthesized recent-activity feed built from order timestamps.

### Communities (Discord-style, multi-tenant)
- Owner creates a community (gets a generated invite code); Workers/Drivers join either by code or by browsing a searchable list — **join is a request, not instant**, gated by owner approval (mirrors the order-approval UX intentionally).
- Everything (orders, dashboard stats, requests) is scoped by `communityId`. Verified two separate communities don't leak data into each other.
- Owner-only "Team" panel: grant/revoke owner-level access to any approved member. Granting fires a one-time "You've been upgraded to owner level" popup the next time that person's identity is active, then drops them straight onto the dashboard. Access is always `isCreator || hasOwnerGrant` — a granted owner cannot themselves grant further (only the true creator sees the Team panel).

### Accounts & role resolution
- Real (browser-local, not secure) accounts: username + password + display name, explicitly labeled as prototype-only in the UI.
- "Skip for now" path still works for people who don't want an account yet — falls back to the old manual role-picker.
- **New in the latest session**: signup now asks "Are you a worker, driver, or owner?" once, stored on the account. Entering *any* community auto-resolves straight to the right screen with no per-visit prompt — owner access always wins if it's real (creator/granted), otherwise falls back to the account's chosen worker/driver preference, otherwise worker. Verified all three branches including the "picked owner but isn't one here → falls back to worker" edge case.
- Profile page (own screen, reachable via top-right pill or the front page): display name, username, account-created date, every community they're in with their role there, log out.
- Communities management screen split out from the front page into its own screen (reachable via a top-right pill next to Profile, and a "Go to Communities →" button on the simplified front page) — the front page itself is now just identity + login state + that one CTA.
- Topbar: community circle (initials, click → switch community), "Menu" pill (Switch role [only shown for skip-mode/no-preference accounts] / Log out).

## Known issues / rough edges

- **No automated tests.** All verification so far has been manual (click-through via `javascript_tool`, screenshot spot-checks). Fine for a prototype at this size; would need addressing before this gets much bigger.
- **Screenshot tool is flaky across sessions** — `computer{action:"screenshot"}` needs the user's Browser pane actually open/focused; it silently times out otherwise with no way for me to force it open. Not a code bug, just a workflow gotcha to remember (ask the user to open the pane first if screenshots matter).
- **Single-browser only, by design** (see CLAUDE.md) — invite codes, accounts, and community membership don't sync across devices because there's no backend yet. This has been surfaced to the user repeatedly and accepted as the current stage of the project, not something to silently fix.

## Architectural decisions worth remembering

- **Why a custom `dev_server.py` instead of `python -m http.server`**: the plain stdlib server caused a real, reproducible bug — edited files served stale via browser conditional-GET caching within the same second as the edit. `dev_server.py` sends `Cache-Control: no-store` on everything to guarantee fresh content during active development.
- **Why owner access is resolved dynamically (`isOwner = isCreator || hasOwnerGrant`) rather than a fixed role field on the community/account**: the user wanted a real permission model — "only the creator is the owner unless someone else is given access" — not a cosmetic label. This also made the later "auto-resolve role at community entry" feature straightforward, since the same `isOwner` check just gets consulted at a different point in the flow.
- **Why the revert lock triggers at `picked_up`, not `delivered`**: user-directed correction — the real point of no return is when the driver has physically collected goods from the supplier, not whenever the driver later marks final delivery complete.
- **Why signup asks the role question once instead of every community visit**: explicit user direction to stop the repeated "Choose your role" prompt; the account now carries a `defaultRole` used to auto-resolve on every community entry, with owner status never overridden by a stale/aspirational preference.
- **Why stockist links go to homepages, not deep product links**: we don't have real product-page URLs for the mock catalog, and guessing one would be actively misleading. The confirm screen is explicit about this ("Opens their homepage in a new tab — this is a demo catalog...").
- **Why `dev_server.py` reads `PORT` from the environment and `launch.json` has `autoPort: true`**: this project can end up open in more than one chat session at once (e.g. the user working from a new chat while an old one is still around), and the second session can't bind port 3000. Auto-picking a free port means a second session still works instead of failing outright — just don't assume the preview is always at `localhost:3000`, use whatever the `preview_start` tool reports.

## Next steps (not started — for whenever the user picks the thread back up)

Roughly in the order they'd naturally come up, not a committed roadmap:

1. **Real backend** — the standing "later" item since the very first login-related request. Needed before: cross-device accounts, real invite-code sharing, real password security, any multi-user testing beyond one browser.
2. **Real password security** — only meaningful once a backend exists to hash/verify server-side; don't add fake hashing client-side in the meantime.
3. Nothing else has been explicitly requested yet — check in with the user before assuming any of the above is next; they've been steering this feature-by-feature rather than off a fixed backlog.

## How to resume work after a context reset

1. Read this file, then [CLAUDE.md](CLAUDE.md).
2. Run `python "dev_server.py"` (or use the `preview_start` tool with name `"buyer-replacement"`, already configured in `.claude/launch.json`) and click through the app to refresh your mental model — it's small enough to tour in a few minutes: auth → community picker → communities → (create/join) → role view.
3. Don't assume anything about "next steps" beyond what's listed above without asking — this project has been driven turn-by-turn by direct user requests, not a spec.
