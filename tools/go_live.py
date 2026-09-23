#!/usr/bin/env python3
"""The go-live switchboard: what's ready, what's left, and the few edits that turn things on.

    python tools/go_live.py check                       # read-only readiness report
    python tools/go_live.py awin --publisher-id 12345 --merchant "Wickes Trade=6789" [--apply] [--apply-db]
    python tools/go_live.py billing-copy [--apply]      # Stripe wording for privacy/terms/refunds
    python tools/go_live.py operator --name "..." --address "..." [--email ...] [--apply]

EVERY command that changes something is a dry run (prints the exact edit / diff)
until you pass --apply. Nothing here creates an account, spends money or talks to
Stripe/Awin - those need an adult and are in .tools/GO_LIVE_RUNBOOK.md. This file
only does the repo/database edits that follow, and it never flips the billing
switch itself: that stays a deliberate, last, manual edit (see the runbook).

The legal wording written by `billing-copy` and the operator swap are drafts of
plain-English policy text, NOT solicitor-reviewed - the runbook says so too.
"""
import argparse
import datetime
import difflib
import html
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT_REF = "rcdrgoxtawlemhzmpcry"
ANON_KEY = "sb_publishable_jBPbTsYSxIP3vi7Tspsu7g_OUEF6ige"  # public: already shipped in public/js/env.js
KNOWN_SUPPLIERS = ["Travis Perkins", "Jewson", "Selco", "Wickes Trade", "MKM Building Supplies", "Buildbase"]
OLD_NAME = "Archie Moore"
OLD_ADDRESS = "23 Grange Mansions, Kingston Road, Surrey, KT17 2AD"
OLD_EMAIL = "arcooreacc@gmail.com"

# ------------------------------------------------------------------ helpers


def read(root, rel):
    return (Path(root) / rel).read_text(encoding="utf-8")


def show_diff(rel, before, after):
    lines = list(difflib.unified_diff(before.splitlines(), after.splitlines(), f"a/{rel}", f"b/{rel}", lineterm="", n=1))
    print("\n".join(lines) if lines else f"(no change to {rel})")


def write_if_changed(root, rel, before, after, apply):
    if before == after:
        print(f"= {rel}: already up to date")
        return False
    if apply:
        (Path(root) / rel).write_text(after, encoding="utf-8")
        print(f"+ {rel}: written")
    else:
        show_diff(rel, before, after)
    return True


def supabase_cli(root=ROOT):
    exe = Path(root) / ".tools" / "supabase.exe"
    if exe.exists():
        return str(exe)
    return shutil.which("supabase")


def db_query(sql, root=ROOT):
    cli = supabase_cli(root)
    if not cli:
        raise RuntimeError("supabase CLI not found (expected .tools/supabase.exe or on PATH)")
    out = subprocess.run([cli, "db", "query", "--linked", sql], cwd=str(root), capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError((out.stdout + out.stderr).strip()[:500])
    body = out.stdout
    start = body.find("{")
    return json.loads(body[start:]) if start >= 0 else {}


# ------------------------------------------------------------------ env.js


def parse_env(text):
    m = re.search(r"awinPublisherId:\s*'([^']*)'", text)
    b = re.search(r"SITESTOCK_BILLING\s*=\s*\{\s*enabled:\s*(true|false)", text)
    return {"awin_publisher_id": m.group(1) if m else None, "billing_enabled": (b.group(1) == "true") if b else None}


def set_awin_publisher(text, publisher_id):
    if not re.fullmatch(r"\d{3,12}", publisher_id):
        raise SystemExit("--publisher-id must be the numeric Awin publisher id (digits only)")
    new, n = re.subn(r"(awinPublisherId:\s*')[^']*(')", r"\g<1>" + publisher_id + r"\g<2>", text, count=1)
    if n != 1:
        raise SystemExit("could not find awinPublisherId in env.js")
    return new


# --------------------------------------------------------------- legal copy
BILL = "billing-copy"


def _wrap(name, body):
    return f"<!-- {BILL}:start:{name} -->\n{body}\n<!-- {BILL}:end:{name} -->"


PRIVACY_COLLECT = """      <dt>Billing information (Premium only)</dt>
      <dd>
        If a company owner upgrades to Premium, they enter their payment details
        on Stripe&rsquo;s own secure page - SiteStock never sees or stores card
        numbers. We keep only Stripe&rsquo;s reference for the customer and
        subscription, the plan status, and the renewal date, against the company.
        Stripe also receives the owner&rsquo;s email address and the company name
        so it can send receipts.
      </dd>
"""

PRIVACY_TABLE_ROW = """          <tr>
            <td>Stripe</td>
            <td>Only if a company owner upgrades to Premium: their email address,
              the company name, and the payment details they enter on Stripe&rsquo;s
              own page</td>
            <td>Takes card payments for the Premium plan and sends receipts</td>
          </tr>
"""

PRIVACY_DETAIL = """      <dt>Stripe</dt>
      <dd>
        Payment processor for the Premium plan. When an owner chooses to upgrade,
        their browser goes to Stripe&rsquo;s hosted checkout; the card details are
        entered there and never reach SiteStock. Stripe acts as an independent
        controller for the payment and fraud-prevention data it collects, under
        <a href="https://stripe.com/gb/privacy" target="_blank" rel="noopener">its own privacy policy</a>.
      </dd>
"""

PRIVACY_RETENTION = """      <li>
        <strong>Billing records</strong> (the Stripe reference, plan status and
        renewal date) are kept while the company exists. Invoices and payment
        records are kept by Stripe, and by us where we need them, for as long as UK
        tax and accounting law requires.
      </li>
"""

TERMS_FEES = """    <p>
      Every company using the Service starts on the Free plan, which includes up
      to 2 sites at no cost.
    </p>
    <p>
      <strong>Premium</strong> removes the 2-site limit for
      <strong>&pound;10 per month</strong> per company (the price shown at
      checkout is the price that applies, including any VAT that applies). A
      Premium subscription:
    </p>
    <ul>
      <li>is bought by a company owner on Stripe&rsquo;s secure payment page - we never see the card details;</li>
      <li>is billed monthly in advance and renews automatically until it is cancelled;</li>
      <li>can be cancelled at any time from Company settings &rarr; Manage subscription - cancelling stops the next renewal, and Premium stays on until the end of the period already paid for;</li>
      <li>if a payment fails, Stripe retries the card for a while; if it still fails, the company returns to the Free plan;</li>
      <li>on returning to the Free plan, your existing sites are kept, but you cannot create or restore sites beyond the 2 the Free plan allows until you upgrade again.</li>
    </ul>
    <p>
      We will give at least 30 days&rsquo; notice of any price change, and a change
      never applies to a period you have already paid for. Cancellation and refunds
      are covered by our <a href="refunds.html">Cancellation &amp; Refunds
      policy</a>, which forms part of these Terms.
    </p>
"""

REFUNDS_NOTE = """    <div class="legal-note">
      <strong>Premium costs &pound;10 per month.</strong> The Free plan costs
      nothing, so there is nothing to refund on it. This page explains cancelling
      and refunds for the paid Premium plan.
    </div>"""


def _pretty_date(d):
    return f"{d.day} {d.strftime('%B %Y')}"


def _bump_updated(text, when):
    return re.sub(r"(Last updated )\d{1,2} \w+ \d{4}", r"\g<1>" + _pretty_date(when), text, count=1)


def apply_billing_copy(files, when=None):
    """files: {'privacy.html': text, 'terms.html': text, 'refunds.html': text} -> same keys, edited.
    Idempotent: a file that already carries the markers is returned unchanged."""
    when = when or datetime.date.today()
    out = dict(files)

    p = files["privacy.html"]
    if f"{BILL}:start" not in p:
        anchors = ["<dt>Supplier links you open</dt>", "Microsoft Clarity", "<dt>Supplier links and affiliate commission</dt>",
                   "<strong>Supplier-link records</strong>"]
        for a in anchors:
            if a not in p:
                raise SystemExit(f"privacy.html has changed shape - cannot find the anchor {a!r}; edit by hand")
        p = p.replace("      <dt>Supplier links you open</dt>",
                      _wrap("collect", PRIVACY_COLLECT.rstrip("\n")) + "\n\n      <dt>Supplier links you open</dt>", 1)
        tb_end = p.index("</tbody>", p.index("Microsoft Clarity"))
        row_start = p.rfind("\n", 0, tb_end) + 1
        p = p[:row_start] + _wrap("row", PRIVACY_TABLE_ROW.rstrip("\n")) + "\n" + p[row_start:]
        p = p.replace("      <dt>Supplier links and affiliate commission</dt>",
                      _wrap("detail", PRIVACY_DETAIL.rstrip("\n")) + "\n      <dt>Supplier links and affiliate commission</dt>", 1)
        li_at = p.index("<strong>Supplier-link records</strong>")
        li_end = p.index("</li>", li_at) + len("</li>")
        p = p[:li_end] + "\n" + _wrap("retention", PRIVACY_RETENTION.rstrip("\n")) + p[li_end:]
        out["privacy.html"] = _bump_updated(p, when)

    t = files["terms.html"]
    if f"{BILL}:start" not in t:
        start_tag = "<h2>10. Fees, cancellation and refunds</h2>"
        end_tag = "<h2>11. Suspension and termination</h2>"
        if start_tag not in t or end_tag not in t:
            raise SystemExit("terms.html section 10 has changed shape; edit by hand")
        a = t.index(start_tag) + len(start_tag)
        b = t.index(end_tag)
        t = t[:a] + "\n" + _wrap("fees", TERMS_FEES.rstrip("\n")) + "\n\n    " + t[b:]
        out["terms.html"] = _bump_updated(t, when)

    r = files["refunds.html"]
    if f"{BILL}:start" not in r:
        m = re.search(r'    <div class="legal-note">\s*<strong>SiteStock is currently free\.</strong>.*?</div>', r, re.S)
        if not m:
            raise SystemExit("refunds.html note has changed shape; edit by hand")
        r = r[:m.start()] + _wrap("note", REFUNDS_NOTE) + r[m.end():]
        r = r.replace("The service is currently free; this covers what applies if paid plans are introduced.",
                      "The Free plan costs nothing; this covers cancellation and refunds for the paid Premium plan.")
        r = r.replace("<h2>1. While the Service is free</h2>", "<h2>1. The Free plan</h2>", 1)
        r = r.replace("<h2>2. If paid plans are introduced</h2>", "<h2>2. The Premium plan</h2>", 1)
        r = r.replace("<p>The following will apply to any paid subscription, unless we clearly state otherwise at the point of sale:</p>",
                      "<p>The following applies to a paid subscription, unless we clearly state otherwise at the point of sale:</p>", 1)
        out["refunds.html"] = _bump_updated(r, when)
    return out


def billing_copy_present(root):
    try:
        return f"{BILL}:start" in read(root, "public/privacy.html") and f"{BILL}:start" in read(root, "public/terms.html")
    except OSError:
        return False


# ----------------------------------------------------------------- operator
OPERATOR_FILES = ["public/dmca.html", "public/eula.html", "public/index.html", "public/privacy.html", "public/terms.html"]


def swap_operator(text, name=None, address=None, email=None):
    if name:
        text = text.replace(OLD_NAME, html.escape(name, quote=False))
    if address:
        text = text.replace(OLD_ADDRESS, html.escape(address, quote=False))
    if email:
        text = text.replace(OLD_EMAIL, email)
    return text


# -------------------------------------------------------------------- check
OK, WARN, BAD, INFO = "[ok]  ", "[todo]", "[FIX] ", "[info]"


def probe(url, headers=None, body=b"{}", timeout=20):
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def run_check(root=ROOT, offline=False, no_db=False, out=print):
    rows = []
    hard_problem = False

    def add(status, text):
        rows.append((status, text))

    env = parse_env(read(root, "public/js/env.js"))
    awin = env["awin_publisher_id"]
    billing_on = env["billing_enabled"]
    add(OK if awin else WARN, f"Awin publisher id in env.js: {awin or 'not set'}")
    add(INFO, f"Billing switch in env.js: {'ON' if billing_on else 'off'}")

    legal = billing_copy_present(root)
    add(OK if legal else WARN, "Stripe wording in privacy/terms/refunds: " + ("present" if legal else "not applied yet (go_live.py billing-copy)"))

    maps = sorted((Path(root) / "tools" / "feeds").glob("*.map.csv"))
    add(OK if maps else WARN, "Feed mapping files: " + (", ".join(m.name for m in maps) if maps else "none yet (tools/suggest_mapping.py drafts one from a real feed)"))

    checkout_ready = webhook_ready = None
    if not offline:
        base = f"https://{PROJECT_REF}.supabase.co/functions/v1"
        hdr = {"apikey": ANON_KEY}
        w = probe(f"{base}/billing-webhook", hdr)
        c = probe(f"{base}/billing-checkout", hdr)
        webhook_ready = (w == 400) if w in (400, 503) else None
        checkout_ready = (c == 401) if c in (401, 503) else None
        add(OK if webhook_ready else WARN if webhook_ready is False else BAD,
            f"billing-webhook: HTTP {w} " + ("(signing secret is set)" if webhook_ready else "(no STRIPE_WEBHOOK_SECRET yet - fails closed)" if webhook_ready is False else "(unexpected - is it deployed?)"))
        add(OK if checkout_ready else WARN if checkout_ready is False else BAD,
            f"billing-checkout: HTTP {c} " + ("(Stripe key + price are set)" if checkout_ready else "(no STRIPE_SECRET_KEY/STRIPE_PRICE_ID yet - fails closed)" if checkout_ready is False else "(unexpected - is it deployed?)"))

    if not no_db:
        try:
            r = db_query("select (select count(*) from products) products, (select count(*) from supplier_branches) branches, "
                         "(select count(*) from suppliers where affiliate_network is not null) affiliate_suppliers, "
                         "(select count(*) from supplier_offers where active) live_offers, "
                         "(select count(*) from company_billing where status in ('active','trialing','past_due')) paying", root)
            row = (r.get("rows") or [{}])[0]
            cat_ok = int(row.get("products", 0)) >= 16 and int(row.get("branches", 0)) >= 12
            add(OK if cat_ok else BAD, f"Hosted catalogue: {row.get('products')} products, {row.get('branches')} branches")
            hard_problem = hard_problem or not cat_ok
            aff = int(row.get("affiliate_suppliers", 0))
            add(OK if aff else WARN, f"Suppliers set up for Awin tracking: {aff}")
            offers = int(row.get("live_offers", 0))
            add(OK if offers else WARN, f"Live supplier offers (real prices): {offers}")
            add(INFO, f"Companies with an active paid subscription: {row.get('paying')}")
        except Exception as exc:  # no login / offline
            add(WARN, f"Hosted database not checked ({str(exc)[:120]}) - run `supabase login` + link, or pass --no-db")

    # consistency: the flag must never lead the things it depends on
    if billing_on:
        if not legal:
            add(BAD, "Billing is ON in env.js but the Stripe wording is not in privacy/terms/refunds - turn it off or run billing-copy")
            hard_problem = True
        if checkout_ready is False or webhook_ready is False:
            add(BAD, "Billing is ON in env.js but the Stripe secrets are not all set - upgrade buttons will show an error")
            hard_problem = True
    elif legal and checkout_ready and webhook_ready:
        add(WARN, "Everything Stripe-side looks ready - after a TEST-mode purchase, flip SITESTOCK_BILLING.enabled to true (last step)")

    for status, text in rows:
        out(f"{status} {text}")
    return 1 if hard_problem else 0


# --------------------------------------------------------------------- CLI


def cmd_awin(args):
    apply = args.apply or args.apply_db
    env = read(ROOT, "public/js/env.js")
    write_if_changed(ROOT, "public/js/env.js", env, set_awin_publisher(env, args.publisher_id), args.apply)
    statements = []
    for spec in args.merchant or []:
        name, _, mid = spec.partition("=")
        name, mid = name.strip(), mid.strip()
        if name not in KNOWN_SUPPLIERS:
            raise SystemExit(f"unknown supplier {name!r}; expected one of {KNOWN_SUPPLIERS}")
        if not re.fullmatch(r"\d{2,10}", mid):
            raise SystemExit(f"merchant id for {name} must be digits only (from the merchant's Awin programme page)")
        statements.append(f"update suppliers set affiliate_network = 'awin', affiliate_merchant_id = '{mid}' where name = '{name}';")
    if not statements:
        print("(no --merchant given: links stay untracked until each supplier has its Awin merchant id)")
        return 0
    sql = "\n".join(statements)
    print("\nSQL for the hosted database:\n" + sql)
    if args.apply_db:
        print(json.dumps(db_query(sql), indent=1)[:400])
    else:
        print("\n(dry run - add --apply-db to run it against the linked hosted project)")
    if not apply:
        print("(dry run - add --apply to write env.js)")
    return 0


def cmd_billing_copy(args):
    rels = {"privacy.html": "public/privacy.html", "terms.html": "public/terms.html", "refunds.html": "public/refunds.html"}
    before = {k: read(ROOT, v) for k, v in rels.items()}
    after = apply_billing_copy(before)
    changed = False
    for k, rel in rels.items():
        changed |= write_if_changed(ROOT, rel, before[k], after[k], args.apply)
    if changed and not args.apply:
        print("\n(dry run - add --apply to write these files)")
    print("\nReminder: this is plain-English policy wording, not solicitor-reviewed.")
    return 0


def cmd_operator(args):
    if not (args.name or args.address or args.email):
        raise SystemExit("give at least one of --name / --address / --email")
    changed = False
    for rel in OPERATOR_FILES:
        before = read(ROOT, rel)
        after = swap_operator(before, args.name, args.address, args.email)
        changed |= write_if_changed(ROOT, rel, before, after, args.apply)
    if args.email:
        for rel in sorted(str(p.relative_to(ROOT)).replace("\\", "/") for p in (ROOT / "public").glob("*.html")):
            if rel in OPERATOR_FILES:
                continue
            before = read(ROOT, rel)
            after = swap_operator(before, email=args.email)
            changed |= write_if_changed(ROOT, rel, before, after, args.apply)
    if changed and not args.apply:
        print("\n(dry run - add --apply to write these files)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="SiteStock go-live switchboard (dry-run unless --apply)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="read-only readiness report")
    c.add_argument("--offline", action="store_true", help="skip the two HTTP probes of the Edge Functions")
    c.add_argument("--no-db", action="store_true", help="skip the hosted database queries")
    a = sub.add_parser("awin", help="record the Awin publisher id / merchant ids")
    a.add_argument("--publisher-id", required=True)
    a.add_argument("--merchant", action="append", help='"Supplier Name=<merchant id>" (repeatable)')
    a.add_argument("--apply", action="store_true", help="write env.js")
    a.add_argument("--apply-db", action="store_true", help="also run the supplier UPDATEs on the linked hosted project")
    b = sub.add_parser("billing-copy", help="add the Stripe wording to privacy/terms/refunds")
    b.add_argument("--apply", action="store_true")
    o = sub.add_parser("operator", help="change who the pages say operates SiteStock")
    o.add_argument("--name")
    o.add_argument("--address")
    o.add_argument("--email")
    o.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "check":
        return run_check(offline=args.offline, no_db=args.no_db)
    return {"awin": cmd_awin, "billing-copy": cmd_billing_copy, "operator": cmd_operator}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
