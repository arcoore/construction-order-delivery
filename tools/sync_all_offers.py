#!/usr/bin/env python3
"""Run import_offers.py once per configured supplier feed.

Used by .github/workflows/sync-offers.yml. The feeds come from ONE environment
variable, OFFER_FEEDS, a JSON object of supplier name -> feed URL:

    {"Wickes Trade": "https://productdata.awin.com/datafeed/download/apikey/.../...csv.gz"}

It is a single secret because an Awin feed URL embeds the account's API key
(so the URL itself is the secret) and GitHub Actions cannot look up a secret by
a computed name. Each supplier needs a hand-built mapping file at
tools/feeds/<slug>.map.csv (slug = lowercase name, non-alphanumerics -> "-",
e.g. "Wickes Trade" -> wickes-trade.map.csv) - see tools/README.md.

Inert by design: no OFFER_FEEDS -> prints why and exits 0, so the scheduled
workflow is harmless until an affiliate account and feed exist. One supplier
failing does not stop the others; the exit code is non-zero if any failed, so a
broken feed shows up as a red run rather than silently stale prices.
"""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_offers  # noqa: E402

FEEDS_DIR = Path(__file__).resolve().parent / "feeds"


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main(env=None, feeds_dir=FEEDS_DIR, run=import_offers.main):
    env = os.environ if env is None else env
    raw = (env.get("OFFER_FEEDS") or "").strip()
    if not raw:
        print("OFFER_FEEDS is not set - no affiliate feeds configured yet, nothing to sync.")
        return 0
    try:
        feeds = json.loads(raw)
    except ValueError:
        print("OFFER_FEEDS is not valid JSON (expected {\"Supplier Name\": \"https://feed-url\"}).", file=sys.stderr)
        return 2
    if not isinstance(feeds, dict) or not feeds:
        print("OFFER_FEEDS must be a non-empty JSON object.", file=sys.stderr)
        return 2

    failures = 0
    for supplier, url in feeds.items():
        mapping = Path(feeds_dir) / f"{slug(supplier)}.map.csv"
        if not mapping.exists():
            print(f"[{supplier}] no mapping file at {mapping} - skipped", file=sys.stderr)
            failures += 1
            continue
        try:
            run(["--supplier", supplier, "--feed", url, "--map", str(mapping)])
        except SystemExit as exc:
            # import_offers raises SystemExit("message") for every refusal
            print(f"[{supplier}] FAILED: {exc}", file=sys.stderr)
            failures += 1
        except Exception as exc:  # network errors etc. - never leak the feed URL
            print(f"[{supplier}] FAILED: {type(exc).__name__}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
