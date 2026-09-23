#!/usr/bin/env python3
"""Propose feed-SKU -> catalogue mappings from a real merchant feed, for a HUMAN to review.

    python tools/suggest_mapping.py --feed feed.csv --out candidates.csv \
        [--draft-map tools/feeds/wickes-trade.map.csv] [--min-score 0.6] [--top 3]

tools/import_offers.py needs a mapping CSV (feed SKU -> product_key + variant
label). Building it by hand from a 30,000-row feed is the slow part of getting
real prices live, so this ranks feed rows against every (product, variant) in the
curated catalogue (tools/catalogue_snapshot.json) and writes:

  * --out         every candidate above --min-score (top N per product+variant),
                  with score, price, stock and URL, so a person can eyeball them
  * --draft-map   only the rows that are unambiguous (both the product and the
                  variant match strongly AND the best candidate clearly beats the
                  runner-up) in import_offers.py's mapping format

It NEVER writes a mapping that the importer will use on its own. The draft is a
starting point: open it next to the candidates file, check each line against the
merchant's site, delete what looks wrong, then run import_offers.py --dry-run.
A wrong automatic match would put a real price on the wrong product, so the
human review is the point, not a formality.

How it scores (kept deliberately simple so a person can predict it):
  * product  - the catalogue name's words (and any keyword) found in the feed title
  * variant  - quantities compared as normalised number+unit tokens: "25 kg" ==
               "25kg", "100 x 100mm x 2.4m" == "100x100mm x 2.4m" == {100mm,100mm,2.4m};
               a feed title carrying a DIFFERENT size of the same unit (10kg vs
               25kg) halves the score, so cement 10kg never masquerades as 25kg
  * total    - 50/50 blend; "confident" needs both halves >= 0.85 and a 0.15 lead

Standard library only.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_offers as io_  # noqa: E402

SNAPSHOT = Path(__file__).resolve().parent / "catalogue_snapshot.json"
UNITS = ("kg", "g", "mm", "cm", "m", "ml", "l", "v", "n", "w")
STOP = {"the", "and", "for", "with", "of", "in", "to", "an", "pack", "each", "per", "by"}
# Packaging nouns in a VARIANT label ("25kg bag", "Box of 200") that merchants
# routinely leave out of a title - their absence must not count against a match.
GENERIC_VARIANT_WORDS = {"bag", "box", "roll", "sheet", "length"}
# A number with an optional unit. The lookbehind stops digits inside words
# ("OSB3") counting as quantities but allows the 'x' of a dimension chain
# ("100x100mm"); the lookahead does the same on the right.
NUM = re.compile(r"(?<![a-wyz\d.])(\d+(?:\.\d+)?)\s*(" + "|".join(UNITS) + r")?(?!(?!x\d)[a-z])")


def _clean_number(text):
    value = float(text)
    return str(int(value)) if value == int(value) else repr(value)


def quantities(text):
    """'100x100mm x 2.4m' -> ['100mm', '100mm', '2.4m']; '25 kg' -> ['25kg'].
    A unit-less number inside a 'A x B x C<unit>' chain inherits the chain's unit."""
    t = text.lower().replace("×", "x")
    found = [(m.start(), m.end(), m.group(1), m.group(2)) for m in NUM.finditer(t)]
    resolved = []
    for i in range(len(found) - 1, -1, -1):
        start, end, num, unit = found[i]
        if unit is None and i + 1 < len(found):
            between = t[end:found[i + 1][0]]
            if re.fullmatch(r"\s*x\s*", between):
                unit = resolved[-1][1]  # the chain's unit, resolved right-to-left
        resolved.append((num, unit))
    resolved.reverse()
    return [_clean_number(n) + (u or "") for n, u in resolved]


def words(text, min_len=2):
    t = re.sub(NUM, " ", text.lower().replace("×", "x"))
    out = []
    for w in re.findall(r"[a-z][a-z\-]*", t):
        w = w.strip("-")
        if len(w) < min_len or w in STOP or w == "x":
            continue
        if w.endswith("ies") and len(w) > 4:
            w = w[:-3] + "y"
        elif w.endswith("s") and not w.endswith("ss") and len(w) > 3:
            w = w[:-1]
        out.append(w)
    return out


def _coverage(needles, haystack):
    if not needles:
        return None
    hay = set(haystack)
    return sum(1 for n in needles if n in hay) / len(needles)


def score_pair(product, variant, title):
    """-> (product_score, variant_score, total). Pure; the whole matching rule."""
    tw = words(title, min_len=1)
    prod_words = words(product["name"])
    kw_words = [w for k in product.get("keywords", []) for w in words(k)]
    name_cov = _coverage(prod_words, tw) or 0.0
    kw_hit = 1.0 if any(w in set(tw) for w in kw_words) else 0.0
    prod_score = 0.7 * name_cov + 0.3 * kw_hit

    v_short = len(variant.strip()) <= 2  # S / M / L / XL: standalone tokens
    v_q = quantities(variant)
    v_w = [w for w in words(variant, min_len=1 if v_short else 2) if w not in GENERIC_VARIANT_WORDS]
    t_q = quantities(title)
    q_cov = _coverage(v_q, t_q)
    w_cov = _coverage(v_w, tw)
    if q_cov is not None and w_cov is not None:
        var_score = 0.7 * q_cov + 0.3 * w_cov
    elif q_cov is not None:
        var_score = q_cov
    elif w_cov is not None:
        var_score = w_cov
    else:
        var_score = 0.5
    if v_q and q_cov is not None and q_cov < 1.0:
        wanted_units = {re.sub(r"[\d.]+", "", q) for q in v_q if re.sub(r"[\d.]+", "", q)}
        stray = [q for q in t_q if re.sub(r"[\d.]+", "", q) in wanted_units and q not in v_q]
        if stray:
            var_score *= 0.5  # a different size of the same kind is a positive mismatch
    return prod_score, var_score, 0.5 * prod_score + 0.5 * var_score


def load_catalogue(path=SNAPSHOT):
    return json.loads(Path(path).read_text(encoding="utf-8"))["products"]


def rank_candidates(feed_rows, products, columns, min_score=0.6, top=3):
    """-> list of dicts, best first within each (product, variant)."""
    prepared = []
    for raw in feed_rows:
        ext = io_.first_value(raw, columns["external_id"])
        title = io_.first_value(raw, columns["title"])
        if not ext or not title:
            continue
        prepared.append({
            "external_id": ext,
            "title": title,
            "price": io_.parse_price(io_.first_value(raw, columns["price"])),
            "in_stock": io_.parse_in_stock(io_.first_value(raw, columns["in_stock"])),
            "url": io_.safe_https(io_.first_value(raw, columns["merchant_url"]))
                   or io_.url_from_aw_deep_link(io_.first_value(raw, columns["aw_deep_link"])),
        })
    out = []
    for product in products:
        for variant in product["variants"]:
            scored = []
            for row in prepared:
                p, v, total = score_pair(product, variant, row["title"])
                if p < 0.5 or total < min_score:
                    continue
                scored.append((total, p, v, row))
            scored.sort(key=lambda s: (-s[0], s[3]["external_id"]))
            for rank, (total, p, v, row) in enumerate(scored[:top], start=1):
                lead = total - scored[rank][0] if rank == 1 and len(scored) > 1 else (1.0 if rank == 1 else 0.0)
                out.append({
                    "product_key": product["key"], "product_name": product["name"], "variant_label": variant,
                    "rank": rank, "score": round(total, 3), "product_score": round(p, 3), "variant_score": round(v, 3),
                    "confident": rank == 1 and p >= 0.85 and v >= 0.85 and lead >= 0.15,
                    "external_id": row["external_id"], "feed_title": row["title"],
                    "price": "" if row["price"] is None else row["price"],
                    "in_stock": "" if row["in_stock"] is None else row["in_stock"], "url": row["url"] or "",
                })
    return out


def draft_mapping(candidates):
    """Confident rank-1 rows only, one row per feed SKU (a SKU can't be two products)."""
    best = {}
    for c in candidates:
        if not c["confident"]:
            continue
        cur = best.get(c["external_id"])
        if cur is None or c["score"] > cur["score"]:
            best[c["external_id"]] = c
    return sorted(best.values(), key=lambda c: (int(re.sub(r"\D", "", c["product_key"]) or 0), c["variant_label"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Suggest feed->catalogue mappings for human review")
    ap.add_argument("--feed", required=True, help="CSV path or https URL (.gz ok)")
    ap.add_argument("--out", required=True, help="candidates CSV to write")
    ap.add_argument("--draft-map", help="also write a draft mapping CSV (confident matches only)")
    ap.add_argument("--catalogue", default=str(SNAPSHOT))
    ap.add_argument("--columns", help="JSON file overriding feed column names (same as import_offers.py)")
    ap.add_argument("--min-score", type=float, default=0.6)
    ap.add_argument("--top", type=int, default=3)
    args = ap.parse_args(argv)

    columns = dict(io_.DEFAULT_COLUMNS)
    if args.columns:
        columns.update(json.loads(Path(args.columns).read_text(encoding="utf-8")))

    products = load_catalogue(args.catalogue)
    feed_rows = list(csv.DictReader(io_.open_text(args.feed)))
    candidates = rank_candidates(feed_rows, products, columns, args.min_score, args.top)

    fields = ["product_key", "product_name", "variant_label", "rank", "score", "product_score", "variant_score",
              "confident", "external_id", "feed_title", "price", "in_stock", "url"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(candidates)

    draft = draft_mapping(candidates)
    if args.draft_map:
        with open(args.draft_map, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["external_id", "product_key", "variant_label"])
            for c in draft:
                w.writerow([c["external_id"], c["product_key"], c["variant_label"]])

    pairs = [(p["key"], v) for p in products for v in p["variants"]]
    covered = {(c["product_key"], c["variant_label"]) for c in draft}
    print(json.dumps({
        "feed_rows": len(feed_rows), "catalogue_pairs": len(pairs),
        "pairs_with_any_candidate": len({(c["product_key"], c["variant_label"]) for c in candidates}),
        "pairs_with_confident_draft": len(covered),
    }))
    missing = [f"{k} / {v}" for k, v in pairs if (k, v) not in covered]
    if missing:
        print("No confident match (needs a human look, or the merchant doesn't stock it):")
        for m in missing:
            print("  -", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
