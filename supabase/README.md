# SiteStock backend foundation (Phase 8A)

**Status: schema + RLS + RPC foundation, locally verified against a real Postgres instance (Phase 8A.5). Still not connected to the live frontend — `public/` is untouched and still runs on `localStorage`. No cloud/production Supabase project exists yet. Phase 8B (frontend wiring) has not started.**

## What this is

This directory is the Postgres/Supabase backend designed in the Phase 8 architecture document and built in Phase 8A. It exists entirely independently of `public/` — the live SiteStock app still runs on its current `localStorage` implementation, unchanged. Nothing here is wired to the frontend yet (that's Phase 8B onward).

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
  tests/                                — pgTAP tests, one concern per file
    00_helpers.sql                     — tests.create_user() / tests.authenticate_as()
    01_isolation_and_permissions.sql   — cross-company isolation, site/buyer permissions
    02_order_lifecycle_and_races.sql   — unauthorized actions, claim/purchase races, cancellation race
    03_notification_isolation.sql      — notification recipient isolation
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

## Security notes for whoever provisions the real project

- The **anon/public key** is safe to embed in frontend code later — that's how Supabase's model works, RLS is the real boundary, not key secrecy.
- The **service-role key** must never be pasted into chat, committed, or shipped to the browser. If manual SQL needs running against a real project before the CLI/migrations path is set up, do it through the Supabase dashboard's SQL editor while logged in as yourself, not by handing the service-role key to anyone or anything else.
- Enable the `pgtap` extension only on a development/test project, never assumed necessary on production.
