import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = "mock_stripe_requests.jsonl"
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "auth": self.headers.get("Authorization"), "body": body}) + "\n")
        if self.path == "/v1/checkout/sessions":
            out = {"id": "cs_test_mock", "url": "https://checkout.stripe.com/c/pay/cs_test_mock"}
        elif self.path == "/v1/billing_portal/sessions":
            out = {"id": "bps_mock", "url": "https://billing.stripe.com/p/session/test_mock"}
        else:
            self.send_response(404); self.end_headers(); return
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
HTTPServer(("0.0.0.0", 9999), H).serve_forever()
