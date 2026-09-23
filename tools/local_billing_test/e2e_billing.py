import json, os, subprocess, time, hmac, hashlib, urllib.request, urllib.error, uuid
from urllib.parse import parse_qs

ANON = os.environ["LOCAL_ANON_KEY"]  # from `supabase status` - local stack only
FN = "http://127.0.0.1:54321/functions/v1/"
CO = "d0000000-0000-0000-0000-0000000000c1"
WH_SECRET = "whsec_mock_secret"


def sess(email):
    return json.loads(subprocess.check_output(["python", "local_session.py", email]))["access_token"]


def call(name, body=None, token=None, headers=None, raw=None, method="POST", origin="http://localhost:3000"):
    h = {"apikey": ANON, "Content-Type": "application/json"}
    if origin:
        h["Origin"] = origin
    if token:
        h["Authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"{}")
    req = urllib.request.Request(FN + name, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read().decode() or "{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt), dict(e.headers)
        except Exception:
            return e.code, txt, dict(e.headers)


def psql(sql):
    return subprocess.check_output(
        ["docker", "exec", "-i", "supabase_db_sitestock", "psql", "-U", "postgres", "-At", "-c", sql]
    ).decode().strip()


def signed_event(evt, secret=WH_SECRET, t=None):
    body = json.dumps(evt)
    t = t or int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return body.encode(), {"stripe-signature": f"t={t},v1={sig}"}


ok = True


def check(label, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + label + (f"  [{extra}]" if extra and not cond else ""))
    ok = ok and bool(cond)


def last_stripe_request():
    lines = [json.loads(l) for l in open("mock_stripe_requests.jsonl")]
    r = lines[-1]
    return r, {k: v[0] for k, v in parse_qs(r["body"]).items()}


owner = sess("demo-owner@test.local")
worker = sess("demo-worker@test.local")
RETURN = "http://localhost:3000/index.html?x=1#h"

# ---------------------------------------------------------------- checkout
s, b, _ = call("billing-checkout", {"communityId": CO, "returnUrl": RETURN}, owner)
check("checkout: owner gets a Stripe URL", s == 200 and str(b.get("url", "")).startswith("https://checkout.stripe.com/"), (s, b))
# (CORS is not asserted here: the local Kong gateway force-injects Access-Control-Allow-Origin: *
#  on every function route, masking the functions' own allow-list. Verify CORS against hosted.)
req, q = last_stripe_request()
check("checkout: Stripe called with the secret key", req["auth"] == "Bearer sk_test_mock_key", req["auth"])
check("checkout: fixed server-side price used", q.get("line_items[0][price]") == "price_mock_10gbp", q)
check("checkout: company on session + subscription", q.get("client_reference_id") == CO and q.get("subscription_data[metadata][community_id]") == CO, q)
check("checkout: return URL query replaced with marker",
      q.get("success_url") == "http://localhost:3000/index.html?billing=success"
      and q.get("cancel_url") == "http://localhost:3000/index.html?billing=cancelled", q)
check("checkout: customer email passed (no customer yet)", q.get("customer_email") == "demo-owner@test.local" and "customer" not in q, q)

s, b, _ = call("billing-checkout", {"communityId": CO, "returnUrl": RETURN}, worker)
check("checkout: a plain worker is refused (403)", s == 403, (s, b))
s, b, _ = call("billing-checkout", {"communityId": CO, "returnUrl": RETURN}, None)
check("checkout: no token is refused", s == 401, (s, b))
s, b, _ = call("billing-checkout", {"communityId": CO, "returnUrl": "https://evil.example/x"}, owner)
check("checkout: an untrusted return origin is refused (400)", s == 400, (s, b))
s, b, _ = call("billing-checkout", {"communityId": "not-a-uuid", "returnUrl": RETURN}, owner)
check("checkout: a malformed company id is refused (400)", s == 400, (s, b))
s, b, _ = call("billing-checkout", {"communityId": str(uuid.uuid4()), "returnUrl": RETURN}, owner)
check("checkout: an unknown company is refused (403)", s == 403, (s, b))

# ----------------------------------------------------------------- webhook
t0 = int(time.time())
sub, cus = "sub_mock_1", "cus_mock_1"
paid = {"id": "evt_e2e_1", "type": "checkout.session.completed", "created": t0,
        "data": {"object": {"mode": "subscription", "payment_status": "paid",
                            "client_reference_id": CO, "customer": cus, "subscription": sub}}}
body, hdr = signed_event(paid)
s, b, _ = call("billing-webhook", raw=body, headers=hdr, origin=None)
check("webhook: valid signature accepted", s == 200 and b.get("outcome") == "applied", (s, b))
check("webhook: company is now Premium in the DB", psql(f"select premium from communities where id='{CO}'") == "t")

s, b, _ = call("billing-webhook", raw=body, headers=hdr, origin=None)
check("webhook: redelivery is a no-op", s == 200 and b.get("outcome") == "duplicate", (s, b))

s, b, _ = call("billing-webhook", raw=body, headers={"stripe-signature": f"t={t0},v1={'0' * 64}"}, origin=None)
check("webhook: forged signature rejected (400)", s == 400, (s, b))
s, b, _ = call("billing-webhook", raw=body, headers={}, origin=None)
check("webhook: missing signature rejected (400)", s == 400, (s, b))
old_body, old_hdr = signed_event({**paid, "id": "evt_old"}, t=t0 - 3600)
s, b, _ = call("billing-webhook", raw=old_body, headers=old_hdr, origin=None)
check("webhook: replayed old timestamp rejected (400)", s == 400, (s, b))
other_body, other_hdr = signed_event({**paid, "id": "evt_other"}, secret="whsec_wrong")
s, b, _ = call("billing-webhook", raw=other_body, headers=other_hdr, origin=None)
check("webhook: signed with the wrong secret rejected (400)", s == 400, (s, b))
check("webhook: none of the rejected calls were recorded",
      psql("select count(*) from billing_events where stripe_event_id in ('evt_old','evt_other')") == "0")

irrelevant = {"id": "evt_inv", "type": "invoice.paid", "created": t0, "data": {"object": {}}}
b2, h2 = signed_event(irrelevant)
s, b, _ = call("billing-webhook", raw=b2, headers=h2, origin=None)
check("webhook: an irrelevant event type is acknowledged (200, not handled)", s == 200 and b.get("handled") is False, (s, b))

# ------------------------------------------------------------------ portal
s, b, _ = call("billing-portal", {"communityId": CO, "returnUrl": RETURN}, owner)
check("portal: owner gets a portal URL", s == 200 and str(b.get("url", "")).startswith("https://billing.stripe.com/"), (s, b))
_, pq = last_stripe_request()
check("portal: Stripe asked for THIS company's customer",
      pq.get("customer") == cus and pq.get("return_url") == "http://localhost:3000/index.html?billing=returned", pq)
s, b, _ = call("billing-portal", {"communityId": CO, "returnUrl": RETURN}, worker)
check("portal: a plain worker is refused (403)", s == 403, (s, b))

s, b, _ = call("billing-checkout", {"communityId": CO, "returnUrl": RETURN}, owner)
check("checkout: an already-Premium company gets 409", s == 409 and b.get("code") == "already_premium", (s, b))

# --------------------------------------------- what an owner can read via REST
def rest(qs, token):
    return urllib.request.urlopen(urllib.request.Request(
        "http://127.0.0.1:54321/rest/v1/company_billing?" + qs,
        headers={"apikey": ANON, "Authorization": "Bearer " + token}))


rows = json.loads(rest("select=status,cancel_at_period_end", owner).read())
check("REST: owner reads their plan status", rows and rows[0]["status"] == "active", rows)
try:
    rest("select=stripe_customer_id", owner)
    check("REST: stripe_customer_id is NOT readable", False)
except urllib.error.HTTPError as e:
    check("REST: stripe_customer_id is NOT readable", e.code in (401, 403), e.code)
rows = json.loads(rest("select=status", worker).read())
check("REST: a plain worker sees no billing rows", rows == [], rows)

# ------------------------------------------------------------ cancellation
dele = {"id": "evt_e2e_del", "type": "customer.subscription.deleted", "created": t0 + 5,
        "data": {"object": {"id": sub, "customer": cus, "status": "canceled", "metadata": {"community_id": CO}}}}
b3, h3 = signed_event(dele)
s, b, _ = call("billing-webhook", raw=b3, headers=h3, origin=None)
check("webhook: cancellation applied", s == 200 and b.get("outcome") == "applied", (s, b))
check("webhook: company is back on Free", psql(f"select premium from communities where id='{CO}'") == "f")

print("\nALL PASS" if ok else "\nSOME FAILED")
