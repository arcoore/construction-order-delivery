import json, os, sys, time, hmac, hashlib, urllib.request

CO = "d0000000-0000-0000-0000-0000000000c1"
SECRET = "whsec_mock_secret"
ANON = os.environ["LOCAL_ANON_KEY"]

kind = sys.argv[1]
now = int(time.time())
period_end = now + 30 * 86400
if kind == "paid":
    evt = {"id": f"evt_{now}_paid", "type": "checkout.session.completed", "created": now,
           "data": {"object": {"mode": "subscription", "payment_status": "paid", "client_reference_id": CO,
                               "customer": "cus_mock_1", "subscription": "sub_mock_2"}}}
elif kind == "active":
    evt = {"id": f"evt_{now}_active", "type": "customer.subscription.updated", "created": now + 1,
           "data": {"object": {"id": "sub_mock_2", "customer": "cus_mock_1", "status": "active",
                               "cancel_at_period_end": False, "current_period_end": period_end,
                               "metadata": {"community_id": CO}}}}
elif kind == "cancelling":
    evt = {"id": f"evt_{now}_cancelling", "type": "customer.subscription.updated", "created": now + 2,
           "data": {"object": {"id": "sub_mock_2", "customer": "cus_mock_1", "status": "active",
                               "cancel_at_period_end": True, "current_period_end": period_end,
                               "metadata": {"community_id": CO}}}}
elif kind == "past_due":
    evt = {"id": f"evt_{now}_pd", "type": "customer.subscription.updated", "created": now + 3,
           "data": {"object": {"id": "sub_mock_2", "customer": "cus_mock_1", "status": "past_due",
                               "cancel_at_period_end": False, "current_period_end": period_end,
                               "metadata": {"community_id": CO}}}}
elif kind == "deleted":
    evt = {"id": f"evt_{now}_del", "type": "customer.subscription.deleted", "created": now + 10,
           "data": {"object": {"id": "sub_mock_2", "customer": "cus_mock_1", "status": "canceled",
                               "metadata": {"community_id": CO}}}}
else:
    raise SystemExit("unknown kind")

body = json.dumps(evt)
sig = hmac.new(SECRET.encode(), f"{now}.{body}".encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(
    "http://127.0.0.1:54321/functions/v1/billing-webhook", data=body.encode(), method="POST",
    headers={"apikey": ANON, "Content-Type": "application/json", "stripe-signature": f"t={now},v1={sig}"})
print(urllib.request.urlopen(req).read().decode())
