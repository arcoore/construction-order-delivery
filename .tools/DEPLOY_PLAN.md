# SiteStock — go-live deploy plan

**Status: NOT YET RUN. Needs the founder's "go" + one email decision (Step 0) first.**

This is the plan referenced by the Snagging List, section 9 ("Push everything
live"). It takes the ~74 finished-but-unpushed commits and the 26 unapplied
database migrations (0024–0049) and makes the current version the one the
public URL serves.

---

## Where things stand right now (2026-09-10)

| | State |
|---|---|
| Live site (`arcoore.github.io/construction-order-delivery/`) | commit `41fa033` — **a pre-redesign build from early September**. `<html lang="en">`, "Communities" not "Companies", no CSP, `privacy.html` is a 404. |
| Local code (`HEAD` = `45782d9`) | **74 commits ahead.** The whole reskin, all legal pages, SEO, the login-security pass, Turnstile (built, off), the leaked-password check, beta-ops, the perf pass, the accessibility pass, the password checklist. Works end-to-end against the local backend. |
| Hosted database (`sitestock-dev`, ref `jntbbrkiygbobknzivpe`, Ireland) | migrations `0001`–`0023` applied (+ `0020`, pushed by mistake earlier). **`0024`–`0049` NOT applied.** |
| pgTAP suite | 38 files / 629 tests, passing locally |
| Email | local = Mailpit (test inbox). Hosted = not configured for real sending. |

**The new frontend hard-requires migrations `0024`–`0040`** (multi-item orders,
MFA, delivery photos, budgets, messaging…). So the push and the migrations
**must go together** — one without the other is a broken site.

**There will be a broken window of ~10–15 minutes** between "migration 0030
applied" (it permanently drops the old single-item order columns, which the
*old* live frontend reads) and "GitHub Pages finishes serving the new
frontend". There are essentially zero real users today, so this is
acceptable — **run the deploy at a quiet time** and just move through it.

---

## Step 0 — decisions the founder must make first

### 0a. Confirmation email — REQUIRED before Step 3

`supabase/.env` currently points at **Mailpit** (local test inbox). If
`config push` runs with that, hosted email is broken. Pick one:

| Option | What happens | What it needs |
|---|---|---|
| **Brevo** (recommended for launch) | Real emails send to anyone, up to 300/day. **From `arcooreacc@gmail.com`** — works, looks a bit amateur, Gmail throttles at volume. | Nothing — account exists, sender verified, key already in `.env` (commented). Claude swaps the block in. |
| **Resend + domain** | Proper `noreply@sitestock.co.uk` sender, better deliverability, 3,000/mo. | A domain (Snagging §3, ~£10/yr) + a free Resend account + DNS records + a wait for "Verified". Not doable today. |
| **Skip email** | Signup can't complete (confirmation is mandatory). Not an option. | — |

→ **Recommended: Brevo now, switch to a domain address later.** It unblocks a real beta today.

### 0b. Supabase Pro — STRONGLY RECOMMENDED before this deploy

`sitestock-dev` is on the **free tier: no automatic backups, and it
auto-pauses after 7 idle days** (a returning beta user finds it "down").
The migration step below includes one destructive migration (`0030`). On the
free tier the *only* safety net is the manual database dump taken in Step 1.

Upgrading to **Pro ($25/mo, needs a card)** adds daily backups + point-in-time
recovery — the real undo button for Step 2. Not a hard blocker; it is the
single biggest risk reducer. Founder's call.

### 0c. Which project (informational, not a blocker)

Deploying onto `sitestock-dev` (Ireland region) is fine and legal under UK
GDPR. A fresh UK-region production project is a separate task (Snagging
`host-region`) and can be done later with one data move.

---

## Pre-flight checklist (do all before touching hosted)

- [ ] Founder has said "go" and chosen the email option (0a).
- [ ] `./.tools/supabase.exe migration list --linked` — record exactly which migrations hosted has. Expect `0001`–`0023` + `0020`.
- [ ] `./.tools/supabase.exe db test` locally — confirm **38 files / 629 tests PASS**.
- [ ] Local `git status` clean; `git log origin/main..HEAD --oneline` is the 74 commits you expect.
- [ ] Know where `supabase/RESTORE_RUNBOOK.md` is and have read it.
- [ ] Pick a low-traffic time.

---

## Step 1 — back up the hosted database

Free tier has no auto-backup. Take a manual dump (per RESTORE_RUNBOOK):

```bash
./.tools/supabase.exe db dump --linked -f "backup-pre-deploy-$(date +%Y%m%d-%H%M).sql"
./.tools/supabase.exe db dump --linked --data-only -f "backup-pre-deploy-data-$(date +%Y%m%d-%H%M).sql"
```

- [ ] Both files exist and are non-trivial in size. **Keep them off this machine too** (copy somewhere safe).
- [ ] Also note current row counts for the key tables (`communities`, `community_memberships`, `orders`, `profiles`) — for the after-check.

**Rollback anchor:** if anything below goes wrong, these dumps + RESTORE_RUNBOOK are how hosted gets restored.

---

## Step 2 — apply migrations 0024–0049 to hosted

```bash
./.tools/supabase.exe db push --linked
```

This applies the 26 pending migrations **in order** in one run.

- [ ] It reports each migration `0024 … 0049` applied, no errors.
- [ ] `./.tools/supabase.exe migration list --linked` now shows local and remote **in sync through 0049**.
- [ ] Spot-check in the Supabase dashboard SQL editor: `select count(*) from orders;` still returns the pre-deploy count; `\d order_items` exists; `select * from app_status;` returns one row (`killed = false`).

**If it fails partway:** note the last migration that succeeded. Do NOT retry
blindly. Restore from the Step 1 dump (RESTORE_RUNBOOK), fix the offending
migration locally against `db reset`, then start Step 2 again.

**Known dashboard prerequisite:** `0029` does `create extension if not exists
pg_cron;`. If hosted doesn't have `pg_cron` enabled, that migration fails —
enable it first in **Dashboard → Database → Extensions**, then re-run.

---

## Step 3 — push the config (email, rate limits, password rules, Turnstile)

**First**, set the email provider chosen in Step 0a:

- **Brevo:** in `supabase/.env`, comment the Mailpit block, uncomment the Brevo block.
- **Resend:** uncomment the Resend block and paste the real `re_…` key into `SMTP_PASS`.

Then:

```bash
./.tools/supabase.exe config push
```

- [ ] Confirms the `[auth]` / `[auth.email]` / `[auth.rate_limit]` config pushed.
- [ ] Turnstile stays **off** (`[auth.captcha] enabled = false`) — that's intended for launch.
- [ ] After this, **revert `supabase/.env` back to Mailpit** so local dev keeps working (it's git-ignored; this is just tidiness).

**Rollback:** `git stash` any `.env` change, `git checkout <old commit> -- supabase/config.toml`, `config push` again.

---

## Step 4 — deploy the account-deletion function

```bash
./.tools/supabase.exe functions deploy delete-account --linked
```

- [ ] Reports deployed. (`0045` created the `anonymize_own_account()` RPC it calls — already applied in Step 2.)

**Rollback:** `git checkout <old commit> -- supabase/functions/delete-account && functions deploy delete-account` (or leave it — the old build had no working delete, so a broken new one is not worse; just disable the Profile button via a hotfix push if needed).

---

## Step 5 — push the frontend

```bash
git push origin main
```

- [ ] GitHub → the repo → Actions tab: the Pages build runs and goes green (~1–2 min).
- [ ] Hard-refresh `https://arcoore.github.io/construction-order-delivery/` — new design loads, `<html lang="en-GB">`, "Companies" not "Communities", `privacy.html` resolves.
- [ ] Browser devtools console: no errors on load.

**Rollback (fast, ~2 min):** `git revert --no-edit 41fa033..HEAD && git push` — or in GitHub, revert the range. Pages rebuilds the old site. (The old *frontend* won't fully work against the *new* schema because of `0030`, but it'll at least load; a real rollback means Step 2's restore too.)

---

## Step 6 — hosted Auth dashboard settings

In **Supabase Dashboard → Authentication → URL Configuration**:

- [ ] **Site URL** = `https://arcoore.github.io/construction-order-delivery/`
- [ ] **Redirect URLs** include that exact URL (for the email-confirm and password-reset links). Add `http://localhost:3000/` too if it isn't there (local dev).
- [ ] (These were set during the Step 5 onboarding work in early Sept — just confirm they survived.)

**Storage → Policies:** the `delivery-photos` bucket policies come from the
migrations (`0039`/`0044`/`0046`) applied in Step 2 — confirm the bucket
exists and is **private**.

---

## Step 7 — smoke test on the live site (founder + Claude)

Run against the **live URL**, not localhost:

- [ ] **Sign up** with a real email you've never used here → confirmation email arrives (check spam) → link works → you land in the app.
- [ ] **Password reset** from the login screen → email arrives → new password works.
- [ ] **Create a company**, invite yourself as a second account, approve, assign a site.
- [ ] **Full order lifecycle**: worker requests → owner approves → buyer purchases (3-sec hold) → driver claims → collects → delivers. No console errors. **Driver never sees a price.**
- [ ] **Delete account** (a throwaible one) → it completes, name still shows on historical orders.
- [ ] Open it **on a phone** — layout holds, sign-in works, the camera works for a delivery photo.
- [ ] Delete the test companies/accounts afterward (one-at-a-time via Dashboard → Auth, + a reviewed SQL cleanup like the WFQA one).

---

## After the deploy — what IS and ISN'T true

**Working for real users:** sign-up + email confirmation, password reset,
companies/sites/teams, the full order→delivery lifecycle, notifications,
in-app messaging, delivery photos, budgets, 2FA (opt-in), account deletion,
the accessibility work, the crash reporter, the kill switch, feedback.

**Still NOT there (separate Snagging List tracks, none are code-at-risk):**

- **No payments / subscriptions** — not built (`pay-build`). It's a free open beta until that ships.
- **No custom domain** — URL stays the GitHub one; email is from a Gmail address until a domain + Resend.
- **No business entity / insurance / ICO registration / solicitor-reviewed terms** — the legal pages are good-faith self-drafted (Snagging §1).
- **No independent accessibility or security audit** (Snagging §8).
- **Free-tier backend** unless Pro was done in Step 0b — auto-pauses when idle, no auto-backups.

---

## One-glance rollback summary

| Step | Undo |
|---|---|
| 5 (frontend) | `git revert 41fa033..HEAD && git push` — ~2 min |
| 4 (function) | redeploy old build from git, or hotfix-hide the button |
| 3 (config) | `git checkout <old> -- supabase/config.toml && config push` |
| 2 (migrations) | **restore the Step 1 dump** per RESTORE_RUNBOOK — the slow, serious one; 0030 is destructive |
| 1 (backup) | n/a — it's the anchor |
