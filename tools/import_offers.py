#!/usr/bin/env python3
"""Import a merchant product feed into SiteStock's supplier_offers table.

    python tools/import_offers.py --supplier "Wickes Trade" \
        --feed feed.csv --map wickes_map.csv [--dry-run]

Reads a CSV (a local path, or an https URL - .csv.gz is fine), keeps only the
rows named in the mapping file, normalises them, and sends the batch to the
import_supplier_offers() database function with the SERVICE-ROLE key. That key
must never reach a browser or a repo: pass it via the environment
(SUPABASE_URL, SUPABASE_SERVICE_KEY), which is exactly what the scheduled
GitHub workflow (.github/workflows/sync-offers.yml) does with repository
secrets.

WHY A MAPPING FILE. SiteStock's catalogue is a curated list (cement, timber
posts, ...), not a mirror of a merchant's 30,000 SKUs. The mapping says which
feed SKU is which SiteStock product (and, optionally, which variant):

    external_id,product_key,variant_label
    WK-1234,p3,25kg bag

Feed rows not in the mapping are ignored. Building the mapping is a human
job on purpose - a wrong automatic match would put a real price on the wrong
product.

FULL-SYNC SEMANTICS. The database function treats each run as the supplier's
complete feed: offers missing from the batch are switched off. So an empty or
truncated download (a failed fetch, a login page saved as .csv) would wipe every
live offer. This tool therefore refuses to send fewer than --min-rows rows
(default 1) unless --allow-empty is passed.

Standard library only - this project has no npm and no pip dependencies beyond
the test tooling.
"""
import argparse
import csv
import gzip
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# canonical field -> feed column names to try, in order. Awin's documented
# product-feed columns come first; the rest are common alternatives. If the
# first real feed uses different headers, override with --columns file.json
# (same shape: {"price": ["my_price_col"], ...}).
DEFAULT_COLUMNS = {
    "external_id": ["merchant_product_id", "aw_product_id", "sku", "id"],
    "title": ["product_name", "title", "name"],
    "price": ["search_price", "store_price", "price"],
    "in_stock": ["in_stock", "stock_status", "availability"],
    "merchant_url": ["merchant_deep_link", "product_url", "link", "url"],
    "aw_deep_link": ["aw_deep_link"],
    "image_url": ["merchant_image_url", "image_url", "image_link", "aw_image_url"],
}

TRUE_WORDS = {"1", "true", "yes", "y", "in stock", "instock", "in_stock", "available"}
FALSE_WORDS = {"0", "false", "no", "n", "out of stock", "outofstock", "out_of_stock", "unavailable"}


def open_text(source):
    """A path or an https URL -> a text stream. Handles .gz by content sniffing."""
    if re.match(r"^https?://", source, re.I):
        if not source.lower().startswith("https://"):
            raise SystemExit("refusing a non-https feed URL")
        req = urllib.request.Request(source, headers={"User-Agent": "SiteStock-offer-sync/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    else:
        with open(source, "rb") as fh:
            raw = fh.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return io.StringIO(raw.decode("utf-8-sig", errors="replace"))


def first_value(row, candidates):
    for name in candidates:
        if name in row and row[name] is not None and str(row[name]).strip() != "":
            return str(row[name]).strip()
    return None


def parse_price(text):
    """'£1,234.50' -> 1234.5 ; None if it isn't a usable positive price."""
    if text is None or re.search(r"-\s*[0-9.]", text):
        return None  # a negative is never a price - do not strip the sign and keep the number
    cleaned = re.sub(r"[^0-9.]", "", text)
    if cleaned.count(".") > 1 or cleaned in ("", "."):
        return None
    try:
        value = round(float(cleaned), 2)
    except ValueError:
        return None
    if value <= 0 or value > 10_000_000:
        return None
    return value


def parse_in_stock(text):
    if text is None:
        return None
    t = text.strip().lower()
    if t in TRUE_WORDS:
        return True
    if t in FALSE_WORDS:
        return False
    return None


def safe_https(url):
    """Only https URLs survive - the value ends up in an <a href> in the app."""
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url.strip())
    except ValueError:
        return None
    if parsed.scheme != "https" or not parsed.netloc or re.search(r"\s", url.strip()):
        return None
    return url.strip()


def url_from_aw_deep_link(aw_link):
    """An Awin tracked link already carries the merchant URL in its `ued`
    parameter. Use that only if there is one; a bare pclick.php link with no
    destination can't be turned back into a merchant URL."""
    if not aw_link:
        return None
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(aw_link).query)
    except ValueError:
        return None
    ued = query.get("ued", [None])[0]
    return safe_https(ued)


def load_mapping(path):
    mapping = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            ext = (row.get("external_id") or "").strip()
            key = (row.get("product_key") or "").strip()
            if not ext or not key:
                continue
            mapping[ext] = {"productKey": key, "variantLabel": (row.get("variant_label") or "").strip() or None}
    return mapping


def build_rows(feed_rows, mapping, columns):
    """Returns (rows, stats). Pure - no I/O - so it can be unit-tested."""
    stats = {"feed_rows": 0, "unmapped": 0, "bad_price": 0, "url_dropped": 0, "mapped_missing_from_feed": 0}
    rows = []
    seen = set()
    for raw in feed_rows:
        stats["feed_rows"] += 1
        ext = first_value(raw, columns["external_id"])
        if not ext or ext not in mapping:
            stats["unmapped"] += 1
            continue
        seen.add(ext)
        price = parse_price(first_value(raw, columns["price"]))
        if price is None:
            stats["bad_price"] += 1
            continue
        merchant_url = safe_https(first_value(raw, columns["merchant_url"]))
        if merchant_url is None:
            merchant_url = url_from_aw_deep_link(first_value(raw, columns["aw_deep_link"]))
        had_url_text = bool(first_value(raw, columns["merchant_url"]) or first_value(raw, columns["aw_deep_link"]))
        if merchant_url is None and had_url_text:
            stats["url_dropped"] += 1
        m = mapping[ext]
        row = {
            "externalId": ext,
            "productKey": m["productKey"],
            "title": first_value(raw, columns["title"]) or ext,
            "unitPrice": price,
        }
        if m["variantLabel"]:
            row["variantLabel"] = m["variantLabel"]
        stock = parse_in_stock(first_value(raw, columns["in_stock"]))
        if stock is not None:
            row["inStock"] = stock
        if merchant_url:
            row["productUrl"] = merchant_url
        image = safe_https(first_value(raw, columns["image_url"]))
        if image:
            row["imageUrl"] = image
        rows.append(row)
    stats["mapped_missing_from_feed"] = len([e for e in mapping if e not in seen])
    return rows, stats


def post_rpc(supabase_url, service_key, supplier, rows):
    url = supabase_url.rstrip("/") + "/rest/v1/rpc/import_supplier_offers"
    body = json.dumps({"p_supplier_name": supplier, "p_rows": rows}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:600]
        raise SystemExit(f"import failed: HTTP {err.code} {detail}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--supplier", required=True, help="exact suppliers.name, e.g. 'Wickes Trade'")
    ap.add_argument("--feed", required=True, help="CSV path or https URL (.gz ok)")
    ap.add_argument("--map", required=True, help="mapping CSV: external_id,product_key,variant_label")
    ap.add_argument("--columns", help="JSON file overriding feed column names")
    ap.add_argument("--min-rows", type=int, default=1, help="refuse to sync fewer rows than this (default 1)")
    ap.add_argument("--allow-empty", action="store_true", help="allow syncing zero rows (switches every offer off)")
    ap.add_argument("--dry-run", action="store_true", help="parse and report, send nothing")
    args = ap.parse_args(argv)

    columns = dict(DEFAULT_COLUMNS)
    if args.columns:
        with open(args.columns, encoding="utf-8") as fh:
            columns.update(json.load(fh))

    mapping = load_mapping(args.map)
    if not mapping:
        raise SystemExit("mapping file has no usable rows")

    reader = csv.DictReader(open_text(args.feed))
    rows, stats = build_rows(reader, mapping, columns)

    print(json.dumps({"supplier": args.supplier, **stats, "importable": len(rows)}))
    if args.dry_run:
        for r in rows[:5]:
            print("  ", json.dumps(r))
        return 0

    if len(rows) == 0 and not args.allow_empty:
        raise SystemExit("refusing to sync 0 rows (would switch every live offer off); use --allow-empty if intended")
    if len(rows) < args.min_rows:
        raise SystemExit(f"only {len(rows)} importable rows, below --min-rows {args.min_rows}; not syncing")

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_KEY (service-role) in the environment")
    print(json.dumps(post_rpc(url, key, args.supplier, rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
