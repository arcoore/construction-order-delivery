# Local billing test kit (mock Stripe)

Drives the **real** `billing-checkout` / `billing-portal` / `billing-webhook` Edge
Functions against your **local** Supabase stack, with a tiny fake Stripe standing in
for `api.stripe.com`. No Stripe account, no network, no real money. Local stack only -
it uses the demo `demo-*@test.local` accounts from `supabase/seed.sql`.

```bash
# 1. local stack up, freshly reset (so seed accounts exist)
supabase start && supabase db reset

# 2. keys for the local stack (printed by `supabase status`)
export LOCAL_ANON_KEY=...            # "anon key"
export LOCAL_SERVICE_ROLE_KEY=...    # "service_role key" - local stack only

# 3. fake Stripe on :9999, and the functions pointed at it
cd tools/local_billing_test
python mock_stripe.py &
cat > /tmp/functions.env <<EOF
STRIPE_SECRET_KEY=sk_test_mock_key
STRIPE_PRICE_ID=price_mock_10gbp
STRIPE_WEBHOOK_SECRET=whsec_mock_secret
STRIPE_API_BASE=http://host.docker.internal:9999
EOF
supabase functions serve --env-file /tmp/functions.env &

# 4. run it
python e2e_billing.py        # ~30 checks; prints PASS/FAIL per line
python send_event.py paid    # or: active | cancelling | past_due | deleted  - fire one signed webhook by hand
```

`STRIPE_API_BASE` is only honoured when `SUPABASE_URL` is `http://` (the local stack), so a
production project can never be pointed away from `api.stripe.com`.

CORS is deliberately not asserted here: the local Kong gateway force-injects
`Access-Control-Allow-Origin: *` on every function route, hiding the functions' own
allow-list. Check CORS against the hosted project after deploying.
