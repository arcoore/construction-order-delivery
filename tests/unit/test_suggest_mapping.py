"""tools/suggest_mapping.py - proposes feed->catalogue mappings for a human to review."""
import csv
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("suggest_mapping", ROOT / "tools" / "suggest_mapping.py")
sm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sm)
import import_offers as io_  # noqa: E402  (same module suggest_mapping imports)

PRODUCTS = sm.load_catalogue()
BY_KEY = {p["key"]: p for p in PRODUCTS}


def feed(*rows):
    """rows: (id, title, price) -> csv.DictReader-style dict list"""
    return [{"merchant_product_id": i, "product_name": t, "search_price": str(p), "in_stock": "1",
             "merchant_deep_link": f"https://example.com/{i}"} for i, t, p in rows]


def top(cands, key, variant):
    return [c for c in cands if c["product_key"] == key and c["variant_label"] == variant]


def test_snapshot_matches_the_seeded_catalogue():
    assert len(PRODUCTS) == 16
    assert sum(len(p["variants"]) for p in PRODUCTS) == 50
    migration = (ROOT / "supabase" / "migrations" / "0020_product_catalogue.sql").read_text(encoding="utf-8")
    for p in PRODUCTS:
        assert f"'{p['key']}'" in migration and p["name"] in migration


@pytest.mark.parametrize("text,expected", [
    ("25 kg", ["25kg"]),
    ("100x100mm x 2.4m", ["100mm", "100mm", "2.4m"]),
    ("100 x 100 mm x 2.4 m", ["100mm", "100mm", "2.4m"]),
    ("2400 x 1200 x 12.5mm", ["2400mm", "1200mm", "12.5mm"]),
    ("3.0m", ["3m"]),
    ("7N 440x215x100mm", ["7n", "440mm", "215mm", "100mm"]),
    ("4x40mm (Box of 200)", ["4mm", "40mm", "200"]),
    ("18V - Body Only", ["18v"]),
    ("OSB3 board", []),   # digits inside a word are not a quantity
])
def test_quantities(text, expected):
    assert sm.quantities(text) == expected


def test_the_right_cement_size_wins_and_the_wrong_size_never_does():
    rows = feed(("A25", "Everbuild General Purpose Cement 25kg", 6.49),
                ("A10", "Everbuild General Purpose Cement 10 kg", 3.15),
                ("GNOME", "Garden Gnome 25kg", 4.99))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    t25 = top(c, "p3", "25kg bag")
    t10 = top(c, "p3", "10kg bag")
    assert t25[0]["external_id"] == "A25" and t25[0]["confident"]
    assert t10[0]["external_id"] == "A10" and t10[0]["confident"]
    # the 10kg row is not even a candidate for the 25kg variant (halved score < min)
    assert all(x["external_id"] != "A10" for x in t25[:1])
    assert not any(x["external_id"] == "GNOME" for x in c)


def test_dimension_chains_match_however_they_are_written():
    rows = feed(("F1", "Treated Timber Fence Post 100 x 100mm x 2.4m", 14.2),
                ("F2", "Treated Timber Fence Post 100x100mm x 1.8m", 11.0))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    assert top(c, "p1", "100x100mm x 2.4m")[0]["external_id"] == "F1"
    assert top(c, "p1", "100x100mm x 1.8m")[0]["external_id"] == "F2"


def test_word_variants_and_single_letter_sizes():
    rows = feed(("H1", "Safety Helmet - Yellow", 7.8),
                ("H2", "Safety Helmet - White", 7.8),
                ("V1", "Hi-Vis Safety Vest XL", 3.25),
                ("V2", "Hi-Vis Safety Vest M", 3.25))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    assert top(c, "p12", "Yellow")[0]["external_id"] == "H1"
    assert top(c, "p12", "White")[0]["external_id"] == "H2"
    assert top(c, "p11", "XL")[0]["external_id"] == "V1"
    assert top(c, "p11", "M")[0]["external_id"] == "V2"


def test_an_ambiguous_tie_is_never_confident():
    rows = feed(("T1", "General Purpose Cement 25kg", 6.0), ("T2", "General Purpose Cement 25kg", 6.1))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    best = top(c, "p3", "25kg bag")[0]
    assert best["confident"] is False   # two identical-scoring rows: a human must choose
    assert sm.draft_mapping(c) == [] or all(d["variant_label"] != "25kg bag" for d in sm.draft_mapping(c))


def test_partial_product_name_is_a_candidate_but_not_confident():
    rows = feed(("P1", "Fence Post 100x100mm x 2.4m", 9.0))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS, min_score=0.5)
    hit = top(c, "p1", "100x100mm x 2.4m")
    assert hit and hit[0]["confident"] is False


def test_a_sku_appears_once_in_the_draft_mapping():
    rows = feed(("A25", "Everbuild General Purpose Cement 25kg", 6.49))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    draft = sm.draft_mapping(c)
    assert [d["external_id"] for d in draft].count("A25") == 1


def test_the_draft_mapping_is_a_valid_importer_mapping(tmp_path):
    feed_csv = tmp_path / "feed.csv"
    feed_csv.write_text(
        "merchant_product_id,product_name,search_price,in_stock,merchant_deep_link\n"
        "A25,Everbuild General Purpose Cement 25kg,6.49,1,https://example.com/a25\n"
        "A10,Everbuild General Purpose Cement 10kg,3.15,1,https://example.com/a10\n", encoding="utf-8")
    cands = tmp_path / "cands.csv"
    draft = tmp_path / "draft.map.csv"
    assert sm.main(["--feed", str(feed_csv), "--out", str(cands), "--draft-map", str(draft)]) == 0
    mapping = io_.load_mapping(draft)
    assert mapping["A25"] == {"productKey": "p3", "variantLabel": "25kg bag"}
    assert mapping["A10"] == {"productKey": "p3", "variantLabel": "10kg bag"}
    # and the importer accepts what the suggester drafted, end to end
    rows, stats = io_.build_rows(csv.DictReader(io.StringIO(feed_csv.read_text(encoding="utf-8"))), mapping, io_.DEFAULT_COLUMNS)
    assert stats["unmapped"] == 0 and len(rows) == 2
    assert {r["variantLabel"] for r in rows} == {"25kg bag", "10kg bag"}


def test_candidates_file_has_the_review_columns(tmp_path):
    feed_csv = tmp_path / "feed.csv"
    feed_csv.write_text("merchant_product_id,product_name,search_price\nA25,Everbuild General Purpose Cement 25kg,6.49\n", encoding="utf-8")
    cands = tmp_path / "c.csv"
    sm.main(["--feed", str(feed_csv), "--out", str(cands)])
    header = next(csv.reader(open(cands, encoding="utf-8")))
    assert {"product_key", "variant_label", "score", "confident", "external_id", "feed_title", "price", "url"} <= set(header)


def test_sample_feeds_from_the_repo_still_map():
    """The synthetic Wickes sample: cement 25kg/10kg and the fence post must be found."""
    rows = list(csv.DictReader(open(ROOT / "tools" / "sample_feed" / "wickes_sample.csv", encoding="utf-8")))
    c = sm.rank_candidates(rows, PRODUCTS, io_.DEFAULT_COLUMNS)
    assert top(c, "p3", "25kg bag")[0]["external_id"] == "WK-SAMPLE-CEM-25"
    assert top(c, "p3", "10kg bag")[0]["external_id"] == "WK-SAMPLE-CEM-10"
    assert top(c, "p1", "100x100mm x 2.4m")[0]["external_id"] == "WK-SAMPLE-POST-24"
