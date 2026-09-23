# Go-live runbook - affiliate income and paid Premium

Written 2026-09-23. Everything that can be built and tested without an adult's accounts
**is** built, deployed and verified (see PROGRESS.md's top entry). This file is the exact
sequence for turning the two revenue streams on once a parent has approved and opened the
accounts. The plain-English version for the parent is the "SiteStock Parent Brief" artifact.

> Legal wording produced by `tools/go_live.py billing-copy` / `operator` is plain-English
> policy text, **not solicitor-reviewed** (same as the existing Terms/Privacy pages).
> Fees quoted here were checked on 2026-09-23 - they change; the linked pages are the truth.

## 0. Who does what

| Only an adult (the account holder) can | Claude / the founder can do, once those exist |
|---|---|
| Sign up to Awin and Stripe, pass ID checks, accept the terms, link a bank account | Everything below in sections 3-6 |
| Join each merchant's Awin programme | Draft the product mapping from a real feed (`suggest_mapping.py`) |
| Decide who the site names as operator | Swap names/addresses everywhere (`go_live.py operator`) |
| Type the Stripe secret keys into `set_stripe_secrets.ps1` | Apply the Stripe legal wording (`go_live.py billing-copy`) |
| Register with HMRC / pay the ICO fee if they apply | Deploy, verify, monitor |

Claude never needs, and should never be sent, a Stripe secret key, webhook secret, feed URL
or the Supabase service-role key. `set_stripe_secrets.ps1` exists so keys go from a hidden
prompt straight into Supabase.

**Hosted database writes and pushes need the founder's explicit go-ahead each time** (an
automated safeguard blocks unattended production writes) - say "go" and it proceeds.

## 1. Decisions to make first (10 minutes, with the parent)

1. **Account holder / operator** - who the accounts and the legal pages name (parent, or
   Archie once 18). Also whether to keep a home address on the public pages.
2. **Payout bank account** - a UK account in the account holder's own name (Stripe requires
   the sole-trader account name to match).
3. **Contact email** - the address on the legal pages and given to Awin/Stripe.
4. **Order of work** - recommended: Awin first (free, slow approvals -> start the clock),
   Stripe in parallel (verification is usually quick), then the test run.

## 2. Accounts (the adult does these; ~1 hour total)

### 2a. Awin (affiliate commission)
1. Sign up as a **publisher**: <https://ui.awin.com/publisher-signup/en/awin/step1>. Individuals
   contracting on their own behalf must be 18+. A small deposit is taken at sign-up and is
   refunded with the first commission payment (the form shows the amount).
2. Application answers (be truthful; do not invent traffic):
   - **Website:** `https://arcoore.github.io/construction-order-delivery/` (or the custom domain).
   - **What it is:** "SiteStock is a web app for small UK building firms to request, approve and
     buy site materials. Inside the ordering workflow, a logged-in buyer sees the supplier the
     request is for and a link to that supplier's product or search page."
   - **Audience:** UK construction/trade businesses. **Traffic:** brand new; launching.
   - **Promotion method:** deep links to specific merchant product pages within a business tool
     (choose the closest listed category; describe honestly in the free-text box).
   - **Disclosure:** links that are affiliate-tagged show "we may earn a commission" beside them
     (already built) and `rel="sponsored"`.
   - **Not done, and never will be:** incentivised clicks, misleading claims, bidding on merchant
     brand terms.
3. Reviewers see the public landing page + Terms/Privacy, not the logged-in app. If Awin asks for
   more, offer a screen recording of the order flow.
4. **Join merchant programmes** from the Awin merchant directory: Wickes first (the researched
   candidate); then any of Jewson / Travis Perkins / Selco / MKM / Buildbase that are listed and
   fit. Each merchant approves separately (days-weeks); a "no" costs nothing. When approved, note
   each merchant's **id** (shown on its programme page).
5. **Product feeds:** Awin -> Toolbox -> **Create-a-Feed**; pick the merchant, format **CSV**,
   compression **gzip**, include at least `merchant_product_id`, `product_name`, `search_price`,
   `in_stock`, `merchant_deep_link`, `merchant_image_url`. The feed URL contains the account API
   key - treat it as a secret. Download a copy to work from.

### 2b. Stripe (Premium payments)
1. Sign up at <https://stripe.com/gb>; choose **individual / sole trader**, UK; verify identity
   (photo ID + proof of address); link a UK bank account in the holder's own name; statement
   descriptor e.g. `SITESTOCK`.
2. Work in **Test mode** first (toggle top-right). In test mode:
   - **Products -> Add product** "SiteStock Premium": recurring, **GBP 10.00 / month**. Copy the
     **Price id** (`price_...`).
   - **Settings -> Billing -> Customer portal:** turn on *Cancel subscriptions* and *Update
     payment method*; add links to `terms.html` and `privacy.html`; save.
   - **Developers -> API keys:** reveal the **Secret key** (`sk_test_...`).
   - **Developers -> Webhooks -> Add endpoint:**
     `https://rcdrgoxtawlemhzmpcry.supabase.co/functions/v1/billing-webhook`, events
     `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`. Copy the **Signing secret**
     (`whsec_...`).
3. Fees (UK, checked 2026-09-23): standard UK cards 1.5% + 20p; premium UK 2.8% + 20p; EEA 2.5% +
   20p; international 3.15% + 20p; Stripe Billing pay-as-you-go 0.7% of billing volume.

### 2c. Admin the adult should check (not blocking, not Claude's call)
- **Tax:** the first GBP 1,000 of gross trading income in a tax year is covered by the trading
  allowance; above that, register for Self Assessment by 5 October after the tax year ends
  (gov.uk: "tax-free allowances on property and trading income").
- **ICO data protection fee:** organisations including sole traders that use personal data pay
  GBP 52/yr (GBP 47 by direct debit) unless exempt - use the ICO's self-assessment tool.
- **Solicitor review** of Terms/Privacy/Refunds before there are many paying customers.
- Optional: a domain + branded email (`.tools/DOMAIN_CUTOVER.md`).

## 3. Affiliate income - turning it on (Claude + founder, ~30 min after a merchant approves)

```bash
python tools/go_live.py check                                   # where things stand
python tools/go_live.py awin --publisher-id 123456 --merchant "Wickes Trade=7890"   # dry run
python tools/go_live.py awin --publisher-id 123456 --merchant "Wickes Trade=7890" --apply --apply-db
```
(the `--apply-db` step writes to production - needs the go-ahead.)

Then the prices:
```bash
python tools/suggest_mapping.py --feed wickes_feed.csv.gz --out candidates.csv --draft-map tools/feeds/wickes-trade.map.csv
```
Open `candidates.csv` beside the draft; check each mapped line against wickes.co.uk (right product,
right size); delete anything doubtful; fill gaps by hand. Only confident matches are drafted.
```bash
python tools/import_offers.py --supplier "Wickes Trade" --feed wickes_feed.csv.gz --map tools/feeds/wickes-trade.map.csv --dry-run
```
Then add three GitHub repository secrets (Settings -> Secrets and variables -> Actions):
`SUPABASE_URL` (`https://rcdrgoxtawlemhzmpcry.supabase.co`), `SUPABASE_SERVICE_KEY` (service-role key -
the founder copies it from the Supabase dashboard; never share it), `OFFER_FEEDS`
(`{"Wickes Trade": "<feed url>"}`). Run **Actions -> Sync supplier offers** once by hand.

Verify: `go_live.py check` shows live offers > 0; on the site a worker's search shows "live prices at
N suppliers"; the buyer's link goes through `awin1.com` and lands on the product; a click appears in
Awin's reports next day (the `clickref` is `so-<order>`).
The Awin column names are from memory and untested on a real feed: if `--dry-run` reports every row
unmapped or bad, pass `--columns cols.json` (`{"price": ["<real column>"]}`) - no code change.

## 4. Premium payments - test mode first (~1 hour)

1. Founder runs, in their own terminal (hidden prompts, test values from 2b):
   `powershell -ExecutionPolicy Bypass -File tools\set_stripe_secrets.ps1`
   then `supabase functions deploy billing-checkout billing-portal billing-webhook --project-ref rcdrgoxtawlemhzmpcry`
   (not needed if already deployed - they are - but harmless).
2. `python tools/go_live.py check` -> webhook `400`, checkout `401` (secrets are in).
3. On the live site, as an owner of a *throwaway company*, open the browser console and run
   `window.SITESTOCK_BILLING.enabled = true`, then go to **Company settings**. This turns the
   button on **in that one tab only** - no other visitor sees anything. Click **Upgrade**, pay with
   Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.
4. Confirm: you land back on Company settings with "your payment went through"; within seconds the
   Plan row says Premium and a 3rd site can be created; Stripe -> Webhooks shows 200s.
5. **Manage subscription** -> cancel in Stripe's portal; confirm the Plan row shows the end date, and
   after the period (or "cancel immediately" in the dashboard) the company drops back to Free and
   can't create a 3rd site. Try a failing card `4000 0000 0000 0341` on a second attempt.
6. Delete the throwaway company (cancel first - deletion is blocked while a subscription is live).

## 5. Go live (founder + Claude, ~1 hour)

1. Parent creates the **live** equivalents (product/price, portal settings, webhook endpoint) and runs
   `set_stripe_secrets.ps1` again with the **live** values (`sk_live_...`, live `price_...`, live `whsec_...`).
2. Operator identity (if changing it):
   ```bash
   python tools/go_live.py operator --name "Jane Smith" --address "..." --email "..."      # review diff
   python tools/go_live.py operator --name "Jane Smith" --address "..." --email "..." --apply
   ```
3. Stripe wording: `python tools/go_live.py billing-copy` (review the diff) then `--apply`.
   Read the three pages once; adjust the numbers/promises (30 days' notice etc.) if the parent
   wants different terms.
4. `python -m pytest -q`, then flip the switch **last**: in `public/js/env.js` set
   `window.SITESTOCK_BILLING = { enabled: true };`, commit and push.
5. `python tools/go_live.py check` -> no `[FIX]` lines. Make one real GBP 10 purchase on a throwaway
   company with the parent's card, confirm Premium turns on, cancel it and refund it in Stripe.
6. Update CLAUDE.md / PROGRESS.md / the launch-blockers memory.

## 6. If something is wrong

| Problem | Fix (all reversible in minutes) |
|---|---|
| Stop new upgrades | `SITESTOCK_BILLING = { enabled: false }` in `env.js`, push (button gone after the ~2 min deploy). Existing subscriptions carry on. |
| Refund / cancel a customer | Stripe dashboard. The webhook updates the plan automatically. |
| A company is stuck on the wrong plan | SQL editor: `update communities set premium = ... where id = ...` still works (the guard only blocks app users). |
| Webhook failing | Stripe -> Webhooks -> the endpoint shows failed deliveries and retries for ~3 days; `go_live.py check`; the function logs in the Supabase dashboard (Edge Functions -> billing-webhook -> Logs). |
| Wrong prices showing | `update supplier_offers set active = false where supplier_id = ...` (or fix the mapping and re-run the sync). Orders keep the price they were placed at. |
| Stop affiliate tagging | Clear `awinPublisherId` in `env.js`; links continue untagged. |
| Everything | The `app_status` kill switch shows a maintenance screen site-wide. |

## 7. What is and is not automated

- Built and tested: the whole data path, both dark switches, the importer + sync workflow, the
  mapping helper, the readiness checker, the Awin/operator/legal-copy editors, the secret-entry helper.
- **Untested against the real thing** (impossible without accounts): the actual Awin feed column names,
  real Stripe checkout pages, real merchant deep-link behaviour under Awin tracking. The mock-Stripe
  run exercises the same code paths and the same request/response shapes from Stripe's documentation.
