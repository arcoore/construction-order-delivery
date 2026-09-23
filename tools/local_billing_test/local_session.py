import json, os, sys, urllib.request
K = os.environ["LOCAL_SERVICE_ROLE_KEY"]  # from `supabase status` - local stack only
B = "http://127.0.0.1:54321/auth/v1"
def call(path, body):
    req = urllib.request.Request(B + path, data=json.dumps(body).encode(), method="POST",
        headers={"apikey": K, "Authorization": "Bearer " + K, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())
email = sys.argv[1]
link = call("/admin/generate_link", {"type": "magiclink", "email": email})
sess = call("/verify", {"type": "magiclink", "token_hash": link["hashed_token"]})
print(json.dumps(sess))
