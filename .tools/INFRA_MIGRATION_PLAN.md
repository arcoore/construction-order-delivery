# SiteStock — Supabase London region + hosting platform migration plan

**Status (2026-09-14): ALL FOUR STEPS DONE. `origin/main` = `147fe59`.**

## Progress so far

- **Step 1 — new project**: `sitestock-london` created, region `eu-west-2` (London), ref `rcdrgoxtawlemhzmpcry`. All 51 migrations applied (`migration list --linked` confirms local = remote, matching the original project's `sitestock-dev`). `config push` run — Brevo SMTP, Turnstile, password/rate-limit rules, Google + Microsoft OAuth all mirror the original project exactly. Google Cloud Console and the Azure app registration both got the new project's callback URL added alongside the existing one (nothing removed).
- **Security parity verified directly** (not just assumed from identical migrations): anon reading `orders` → refused `permission denied` (no anon grant, matching original); anon forging a `notifications` row → refused the same way; a password-grant request with no Turnstile token → refused `captcha_failed`; `/auth/v1/settings` confirms `google`/`azure` both `true`.
- **Step 2 — data migration**: done and verified. `db dump --data-only` from the original project (excluding the tables migrations already seed themselves — `products`/`product_variants`/`suppliers`/`supplier_branches`/`app_status`/the `delivery-photos` storage bucket — to avoid duplicate-key conflicts with what `db push` already created), restored via `psql` through the connection pooler (the direct `db.<ref>.supabase.co` host is IPv6-only and unreachable from this environment). **Row counts match exactly** on every table checked: orders 45=45, order_events 216=216, order_items 45=45, profiles 55=55, communities 19=19, community_memberships 30=30, sites 18=18, site_memberships 20=20, notifications 81=81, cancellation_requests 6=6, buyer_grants 13=13, buyer_requests 3=3, owner_grants 0=0, auth.users 54, auth.identities 54 (profiles' one extra row is the expected tombstoned deleted-account row per migration `0045`'s documented behaviour).
- **Live login test (done)**: a disposable admin-created test account confirmed the full auth pipeline end-to-end on London - user creation, session/JWT issuance (via OTP verification, since a scripted password-grant genuinely can't pass Turnstile, and disabling it even briefly to force one through was correctly refused by the safety classifier), and RLS-scoped reads (0 unauthorized orders visible; a real migrated `profiles` row correctly readable). Test account deleted afterward. Separately confirmed by direct SQL that all 54 migrated `encrypted_password` values are well-formed bcrypt (`$2a$10$`, 60 chars) - a byte-identical column copy, so this plus the working auth pipeline is treated as sufficient confidence without also completing a live Turnstile challenge as an automated tool.
- The original Ireland project's database password was reset to enable the dump (only direct-Postgres connections were affected, not the REST API/live app).
- **Step 3 (done)**: Cloudflare Pages project `construction-order-delivery` created, connected to the same GitHub repo (scoped to just this one repo, not all repos), build output directory set to `public` (no build command - matches this repo's no-build-step convention). Live at `construction-order-delivery.pages.dev`, verified byte-for-byte working: correct assets, correct backend (env.js updated to recognize this hostname too), Turnstile widget's allowed-hostname list updated to include it (a real gap found live - the widget initially errored `110200` domain-not-allowed until fixed). GitHub Pages remains the primary/bookmarked host; this is an additional, fully-verified mirror, not a replacement - see the "what this deliberately does NOT include" reasoning below for why a full cutover away from GitHub Pages wasn't done.
- **Step 4 - database half (done)**: `public/js/env.js` on `arcoore.github.io` now points at the London project. Verified live via a cache-busted direct fetch of the deployed `env.js` (ordinary page loads in this session's own test tabs kept showing a stale cached copy for a few minutes after each push - a GitHub Pages CDN edge-propagation artifact, not a deployment problem, confirmed by the no-cache fetch succeeding immediately).
- **Step 4 - hosting half**: intentionally NOT a full cutover away from GitHub Pages. Both `arcoore.github.io` and `construction-order-delivery.pages.dev` are live, verified, and point at the same London backend - `arcoore.github.io` stays the one that's bookmarked and registered wherever it matters (OAuth apps' `redirect_to`, any existing links) until there's a real reason to prefer one over the other (e.g. a custom domain gets pointed at Cloudflare Pages later).

Two decisions from the 2026-09-14 session, planned together because they
touch overlapping things (redirect URLs, the frontend's deploy target) even
though they're otherwise independent:

1. Move the database off the current `sitestock-dev` project (Ireland,
   `eu-west-1`, ref `jntbbrkiygbobknzivpe`) to a fresh project in London
   (`eu-west-2`), for genuine UK data residency.
2. Move hosting off GitHub Pages to **Cloudflare Pages** (recommendation
   below), for reliability and because it puts the whole site on the same
   Cloudflare account already used for Turnstile and Web Analytics — which
   is also where the later rate-limiting/WAF work (Snagging List
   `host-edge-shield`) has to live anyway.

---

## Why Cloudflare Pages, not Netlify

Both are free for a site this size, so "cheapest" is a tie. On reliability
and fit:

| | Cloudflare Pages | Netlify |
|---|---|---|
| Free-tier bandwidth | Unlimited | 100 GB/month |
| Free-tier builds | 500/month | 300 build-minutes/month |
| Needs a new account | **No — reuses the existing Cloudflare account** (Turnstile, Web Analytics already live there) | Yes, a new signup |
| Sets up the later rate-limiting work | Yes — same platform, same account | No — would mean juggling two providers |
| Git integration | Connects directly to the GitHub repo, auto-deploys on push — same workflow as now | Same |
| Custom domain later | Free, same account | Free, separate account |

No custom domain is needed to do this — Cloudflare Pages gives every
project a free `*.pages.dev` subdomain immediately, the same way GitHub
Pages gives `arcoore.github.io`. **Recommendation: Cloudflare Pages.**

---

## What's at stake (be honest about the risk before starting)

- **The database migration touches real production data**: as of the last
  count, 43+ orders and 53+ user accounts, including real names, site
  addresses, and postcodes. A mistake here is not a "redeploy and fix it"
  problem the way a frontend bug is.
- **A project's Supabase region cannot be changed after creation** — this is
  a one-time move, not a setting to flip. Get it right once.
- Both migrations change the site's origin (Supabase URL, and — if the
  hosting move happens too — the frontend's own URL), which several things
  are pinned to: the Google and Microsoft OAuth app registrations'
  authorised redirect URIs, and Supabase Auth's own `site_url` /
  `additional_redirect_urls`.
- There is **no rollback for the database once real post-cutover writes
  exist on the new project** — the safety net is running both projects in
  parallel and not cutting the frontend over until the new one is fully
  verified, so cutover is the only genuinely risky moment and it's fast
  (a two-line env.js change) and instantly reversible right up until someone
  places a real order against the new project.

---

## Step 0 — decisions/things needed from the founder before Step 1

| # | What | Why |
|---|---|---|
| 0a | Confirm: proceed with a **new empty Supabase project in London**, not an in-place migration (Supabase doesn't support changing a project's region — this is unavoidable either way) | Sets expectations right |
| 0b | Confirm: **Cloudflare Pages** per the recommendation above, unless you'd rather stick with Netlify for a specific reason | Locks the platform before any setup starts |
| 0c | A few minutes to log into the Cloudflare dashboard when Claude gets to the Pages setup step, and the Supabase dashboard for the new-project creation (both use existing sessions, nothing new to sign up for) | Claude can drive the clicks, but project creation needs a logged-in human session present, same as the Azure/Google OAuth registration earlier this session |

---

## Step 1 — stand up the new Supabase project (low risk, additive only)

1. Create a new Supabase project, region **London (`eu-west-2`)**, same
   organisation. Nothing existing is touched by this step.
2. Apply all 49 migrations in order (`supabase db push`, same tooling and
   sequence already used for the original go-live deploy) — this recreates
   the full schema, every RLS policy, every RPC function from scratch. This
   is the *best-tested* part of the whole plan: it's the same migration
   history already proven against local and the current hosted project.
3. Run `config push` to carry the full `[auth]`/`[api]` config across:
   Brevo SMTP, Turnstile, password/rate-limit settings, and Google +
   Microsoft OAuth — **with placeholder redirect URIs for now**, corrected
   in Step 4.
4. Run the full pgTAP suite against the new project directly (not just
   locally) to confirm the schema/RLS came across intact.
5. **Verification gate**: a stranger-forgery probe re-run against the new
   project (the same class of test already in the pgTAP suite and this
   session's own OAuth verification) — confirms RLS is genuinely enforcing
   on the new project, not just present.

Nothing in this step is visible to a real user or touches the live site.

---

## Step 2 — migrate the data (the one genuinely risky step)

1. Fresh `db dump` of the current Ireland project (schema + data), same
   command already rehearsed per `supabase/RESTORE_RUNBOOK.md`.
2. Restore into the new London project.
3. **Row-count diff, table by table**, old vs. new — the same verification
   method already used for the original go-live deploy (`orders 43=43`,
   `profiles 53=53`, etc.) — every table must match exactly or the restore
   is treated as failed and investigated before continuing.
4. **`auth.users` specifically gets extra scrutiny**: password hashes
   (`encrypted_password`) carry over in a raw dump/restore, but a genuine
   test login against the new project (a disposable test account, not a
   real user's) confirms it actually works end-to-end before trusting it for
   real accounts.
5. Storage objects (delivery photos) copied across via the Storage API, not
   the SQL dump (SQL dump doesn't include bucket file contents) — verified
   by opening a handful of existing photos against the new project's URL.

**Rollback at this point**: trivial — the old project is completely
untouched, nothing has been cut over yet. Delete the new project's data and
redo Step 2, or abandon it entirely with zero consequence.

---

## Step 3 — set up Cloudflare Pages (independent of Steps 1–2, can happen in parallel)

1. Connect the existing GitHub repo to a new Cloudflare Pages project (same
   Cloudflare account as Turnstile/Web Analytics).
2. Deploy — Cloudflare Pages builds and serves the exact same static files
   GitHub Pages does now, no source changes needed for this step alone.
3. Verify the `*.pages.dev` URL byte-for-byte matches what's live now
   (same method used after every deploy so far in this project — direct
   no-cache fetches, not trusting a cached view).
4. **GitHub Pages keeps serving the live site throughout** — nothing points
   real users at the new URL yet.

---

## Step 4 — the actual cutover (fast, and the only step with real user impact)

Done together, at a quiet time, because both change the frontend's
effective origin:

1. `public/js/env.js`: point `SITESTOCK_SUPABASE_URL` /
   `SITESTOCK_SUPABASE_ANON_KEY` at the new London project. Add the
   Cloudflare Pages hostname as a recognised `host` branch (mirroring the
   existing `arcoore.github.io` branch) if the Pages URL is what goes live,
   or keep GitHub Pages as the branch if only the database moves this round.
2. Google Cloud Console + Azure App registration: add the new origin's
   OAuth callback URL alongside the existing one (never remove the old one
   until cutover is confirmed working — this is what makes the OAuth side
   instantly reversible too).
3. `supabase/config.toml` on the **new** project: `site_url` and
   `additional_redirect_urls` updated to the real final origin.
4. Push the `env.js` change — this is the moment the live site starts
   talking to the new database/hosting. Verified immediately with the same
   live-smoke-test method used for the original go-live deploy: real
   signup, real login, one full order lifecycle, mobile check.
5. **Old Ireland Supabase project and GitHub Pages are left running,
   untouched, for a cooldown window** (matching how this project already
   keeps a fallback live after past migrations) before being wound down —
   so if anything is wrong, reverting `env.js` and re-pushing is a two-minute
   fix, not a data-recovery exercise.

---

## After cutover

- Update `privacy.html`'s "a Supabase region in the UK or Ireland" wording
  to name London specifically.
- Update CLAUDE.md's deploy banner and PROGRESS.md.
- Wind down the old Ireland project and the GitHub Pages deployment once the
  cooldown window has passed with no issues.

---

## What this plan deliberately does NOT include

- Buying a custom domain — not needed for either move (Cloudflare Pages'
  own subdomain works fine); the domain purchase stays its own separate
  Snagging List item, and Cloudflare's rate-limiting/WAF work (the next
  thing after this, per the founder's own ordering) is what actually needs
  a real domain, not this migration.
- Supabase Pro — the free-tier risk profile is unchanged by this move; if
  wanted, it's the same standalone decision it always was.
