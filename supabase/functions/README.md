# Edge Functions

| Function | Purpose | Auth | Live? |
|---|---|---|---|
| `delete-account` | Self-service account deletion (needs the service role, so it can't run in the browser) | caller's JWT | yes |
| `billing-checkout` | Starts a Stripe Checkout Session to upgrade a company to Premium | caller's JWT + `billing_checkout_context()` (must be an owner) | **dark** - answers 503 until Stripe secrets exist |
| `billing-portal` | Opens Stripe's customer portal (update card / cancel) | same | **dark** |
| `billing-webhook` | Stripe -> SiteStock: the only thing that can set `communities.premium` from a payment | Stripe HMAC signature (`verify_jwt = false`) | **dark** |
| `_shared/` | Pure helpers (`stripe.ts`: signature check, event mapping, form encoding; `http.ts`: CORS; `caller.ts`: JWT) | - | - |

## Premium billing - status and go-live

Built and tested against a **mock Stripe** (no Stripe account exists yet: the
account holder must be 18+, and the founder is not). The database half is
migration `0055`; the browser half is `public/js/billing.js`. It stays dark in
production until every step below is done, in this order:

1. **Stripe account** (an adult): create it, complete business verification, add a
   UK bank account.
2. **Product + price:** Dashboard -> Products -> "SiteStock Premium", recurring,
   GBP 10.00 / month. Copy the **Price ID** (`price_...`).
3. **Customer portal:** Settings -> Billing -> Customer portal -> enable "Cancel
   subscriptions" and "Update payment method". Set the business/T&C/privacy links
   (`terms.html`, `privacy.html`).
4. **Secrets on the Supabase project** (never in git, never in the browser):
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_PRICE_ID=price_... --project-ref rcdrgoxtawlemhzmpcry
   ```
5. **Webhook:** Stripe -> Developers -> Webhooks -> Add endpoint
   `https://rcdrgoxtawlemhzmpcry.supabase.co/functions/v1/billing-webhook`, events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy the
   signing secret (`whsec_...`) and set it:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref rcdrgoxtawlemhzmpcry
   ```
6. **Test mode first:** do steps 1-5 with Stripe's *test* keys, flip the flag (step 8)
   on a branch/preview, buy with card `4242 4242 4242 4242`, confirm the company turns
   Premium, cancel from the portal, confirm it turns back to Free. Then swap in live keys.
7. **Legal copy (must land before real money moves):** `privacy.html` needs Stripe added
   as a payment processor (what it receives: email, company name, payment details entered
   on Stripe's page - SiteStock never sees card numbers); `terms.html` section 10 needs the
   real billing terms (auto-renewal, how to cancel, refunds - see `refunds.html`).
   *Do this before step 8, not after.*
8. **Flip the browser flag:** `public/js/env.js` -> `window.SITESTOCK_BILLING = { enabled: true }`.
   This is the last step; until then no payment button exists anywhere.

Deploy the functions once (safe while dark - they answer 503 without secrets):

```bash
supabase functions deploy billing-checkout billing-portal billing-webhook --project-ref rcdrgoxtawlemhzmpcry
```

### Behaviours worth knowing before launch

- **Who can pay:** any *owner* of the company (creator or granted owner), not only the creator.
- **Which statuses are Premium:** `active`, `trialing`, and `past_due` (Stripe is still retrying
  the card). It switches off at `canceled`/`unpaid`.
- **Downgrade deletes nothing.** A lapsed company keeps its sites; it just can't create or
  restore more than 2 until it upgrades again (the 0052 cap only fires on create/restore).
- **A company with a live subscription can't be deleted** until it is cancelled (migration
  `0055` trigger), so a card can't keep being charged for a company that no longer exists.
- **Idempotent + order-safe:** Stripe may redeliver or reorder events; `billing_events`
  (unique event id) and `company_billing.last_event_created` make both harmless.
- **Failure mode:** if the webhook is down, payments still succeed at Stripe but Premium
  doesn't switch on until Stripe's retries land (it retries for ~3 days). Check
  Stripe -> Webhooks -> the endpoint for failed deliveries.
- **The founder can still flip `premium` by hand** (SQL editor) exactly as before - the
  Plan row shows such a company as "Premium - unlimited sites" with no Manage button.

### Testing locally (no Stripe account needed)

`tools/local_billing_test/` has a mock Stripe API plus an end-to-end script that drives the
real functions: see its README. Unit tests: `deno test supabase/functions/_shared/` (run in
CI as "Edge Function unit tests (Deno)").
