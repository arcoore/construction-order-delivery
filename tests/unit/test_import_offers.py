"""tools/import_offers.py - the feed -> supplier_offers importer.

Everything that decides what reaches the database lives in pure functions
(`build_rows`, `parse_price`, `safe_https`, ...) so it is tested here without a
network or a database. The database half (dedupe, full-sync, manual-offer
protection) is covered by supabase/tests/42_supplier_offers.sql.
"""
import csv
import importlib.util
import io
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("import_offers", ROOT / "tools" / "import_offers.py")
io_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(io_mod)

SAMPLES = ROOT / "tools" / "sample_feed"


def rows_of(text):
    return list(csv.DictReader(io.StringIO(text)))


@pytest.mark.parametrize(
    "text,expected",
    [
        ("6.49", 6.49),
        ("£3.15", 3.15),
        (" 1,234.50 ", 1234.5),
        ("GBP 12", 12.0),
        ("0", None),
        ("0.00", None),
        ("-4", None),  # a negative is refused, not silently turned positive
        ("", None),
        (None, None),
        ("free", None),
        ("1.2.3", None),
        ("99999999", None),  # above the database's ceiling
    ],
)
def test_parse_price(text, expected):
    assert io_mod.parse_price(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("1", True), ("true", True), ("In Stock", True), ("yes", True),
        ("0", False), ("out of stock", False), ("No", False),
        ("backorder", None), ("", None), (None, None),
    ],
)
def test_parse_in_stock(text, expected):
    assert io_mod.parse_in_stock(text) is expected


@pytest.mark.parametrize(
    "url,ok",
    [
        ("https://www.wickes.co.uk/p/1", True),
        ("http://www.wickes.co.uk/p/1", False),
        ("javascript:alert(1)", False),
        ("data:text/html,x", False),
        ("//evil.example/x", False),
        ("https://", False),
        ("https://a.example/has space", False),
        ("", False),
        (None, False),
    ],
)
def test_safe_https(url, ok):
    assert (io_mod.safe_https(url) is not None) is ok


def test_url_recovered_from_awin_link_only_when_it_carries_a_destination():
    tracked = "https://www.awin1.com/pclick.php?p=1&a=2&m=3&ued=https%3A%2F%2Fwww.wickes.co.uk%2Fp%2F9"
    assert io_mod.url_from_aw_deep_link(tracked) == "https://www.wickes.co.uk/p/9"
    # A bare pclick link cannot be turned back into a merchant URL - never guess.
    assert io_mod.url_from_aw_deep_link("https://www.awin1.com/pclick.php?p=1&a=2&m=3") is None
    # ...and a destination that isn't https is refused too.
    assert io_mod.url_from_aw_deep_link("https://www.awin1.com/pclick.php?ued=javascript%3Aalert(1)") is None
    assert io_mod.url_from_aw_deep_link(None) is None


def test_wickes_sample_end_to_end():
    mapping = io_mod.load_mapping(SAMPLES / "wickes_map.csv")
    feed = rows_of((SAMPLES / "wickes_sample.csv").read_text(encoding="utf-8"))
    rows, stats = io_mod.build_rows(feed, mapping, io_mod.DEFAULT_COLUMNS)

    by_id = {r["externalId"]: r for r in rows}
    # 6 feed rows: 1 unmapped (gnome), 1 zero price -> 4 importable
    assert stats["feed_rows"] == 6
    assert stats["unmapped"] == 1
    assert stats["bad_price"] == 1
    assert set(by_id) == {"WK-SAMPLE-CEM-25", "WK-SAMPLE-CEM-10", "WK-SAMPLE-POST-24", "WK-SAMPLE-BAD-URL"}

    cem25 = by_id["WK-SAMPLE-CEM-25"]
    assert cem25["productKey"] == "p3" and cem25["variantLabel"] == "25kg bag"
    assert cem25["unitPrice"] == 6.49 and cem25["inStock"] is True
    assert cem25["productUrl"] == "https://example.com/wickes/cement-25kg"

    assert by_id["WK-SAMPLE-CEM-10"]["unitPrice"] == 3.15  # "£3.15" parsed
    assert by_id["WK-SAMPLE-POST-24"]["inStock"] is False   # kept, but flagged out of stock

    # The poisoned URL row still imports (the price is fine) but with NO link.
    bad = by_id["WK-SAMPLE-BAD-URL"]
    assert "productUrl" not in bad
    assert stats["url_dropped"] == 1


def test_every_emitted_url_is_https_whatever_the_feed_says():
    mapping = {"A": {"productKey": "p1", "variantLabel": None}}
    feed = rows_of(
        "merchant_product_id,product_name,search_price,merchant_deep_link,merchant_image_url\n"
        "A,Thing,5,javascript:alert(1),data:image/png;base64,AAAA\n"
    )
    rows, _ = io_mod.build_rows(feed, mapping, io_mod.DEFAULT_COLUMNS)
    assert rows == [{"externalId": "A", "productKey": "p1", "title": "Thing", "unitPrice": 5.0}]


def test_mapped_skus_missing_from_the_feed_are_counted():
    mapping = io_mod.load_mapping(SAMPLES / "jewson_map.csv")
    feed = rows_of("merchant_product_id,product_name,search_price\nJW-SAMPLE-CEM-25,x,5.90\n")
    rows, stats = io_mod.build_rows(feed, mapping, io_mod.DEFAULT_COLUMNS)
    assert len(rows) == 1
    assert stats["mapped_missing_from_feed"] == 1


def test_column_override_for_a_differently_shaped_feed():
    columns = dict(io_mod.DEFAULT_COLUMNS, external_id=["sku_code"], price=["gross"])
    mapping = {"X1": {"productKey": "p2", "variantLabel": None}}
    feed = rows_of("sku_code,gross,product_name\nX1,7.5,Rebar\n")
    rows, _ = io_mod.build_rows(feed, mapping, columns)
    assert rows[0]["unitPrice"] == 7.5


def test_output_is_valid_json_for_the_rpc():
    mapping = io_mod.load_mapping(SAMPLES / "wickes_map.csv")
    feed = rows_of((SAMPLES / "wickes_sample.csv").read_text(encoding="utf-8"))
    rows, _ = io_mod.build_rows(feed, mapping, io_mod.DEFAULT_COLUMNS)
    payload = json.loads(json.dumps({"p_supplier_name": "Wickes Trade", "p_rows": rows}))
    assert all({"externalId", "productKey", "title", "unitPrice"} <= set(r) for r in payload["p_rows"])


def test_empty_result_is_refused_before_any_network_call(tmp_path, monkeypatch):
    """A full-sync of zero rows would switch every live offer off, so a bad
    download (login page saved as .csv, wrong mapping) must stop here."""
    feed = tmp_path / "f.csv"
    feed.write_text("merchant_product_id,product_name,search_price\nNOPE,x,1\n", encoding="utf-8")
    m = tmp_path / "m.csv"
    m.write_text("external_id,product_key,variant_label\nA,p1,\n", encoding="utf-8")
    monkeypatch.setattr(io_mod, "post_rpc", lambda *a, **k: pytest.fail("must not reach the network"))
    monkeypatch.setenv("SUPABASE_URL", "https://x.example")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "k")
    with pytest.raises(SystemExit) as exc:
        io_mod.main(["--supplier", "S", "--feed", str(feed), "--map", str(m)])
    assert "refusing to sync 0 rows" in str(exc.value)


def test_min_rows_guard(tmp_path, monkeypatch):
    feed = tmp_path / "f.csv"
    feed.write_text("merchant_product_id,product_name,search_price\nA,x,1\n", encoding="utf-8")
    m = tmp_path / "m.csv"
    m.write_text("external_id,product_key,variant_label\nA,p1,\nB,p2,\n", encoding="utf-8")
    monkeypatch.setattr(io_mod, "post_rpc", lambda *a, **k: pytest.fail("must not reach the network"))
    monkeypatch.setenv("SUPABASE_URL", "https://x.example")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "k")
    with pytest.raises(SystemExit) as exc:
        io_mod.main(["--supplier", "S", "--feed", str(feed), "--map", str(m), "--min-rows", "2"])
    assert "below --min-rows" in str(exc.value)


def test_dry_run_never_needs_credentials_or_network(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    monkeypatch.setattr(io_mod, "post_rpc", lambda *a, **k: pytest.fail("dry run must not post"))
    rc = io_mod.main([
        "--supplier", "Wickes Trade",
        "--feed", str(SAMPLES / "wickes_sample.csv"),
        "--map", str(SAMPLES / "wickes_map.csv"),
        "--dry-run",
    ])
    assert rc == 0
    first = json.loads(capsys.readouterr().out.splitlines()[0])
    assert first["importable"] == 4


def test_missing_credentials_fail_loudly(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    with pytest.raises(SystemExit) as exc:
        io_mod.main([
            "--supplier", "Wickes Trade",
            "--feed", str(SAMPLES / "wickes_sample.csv"),
            "--map", str(SAMPLES / "wickes_map.csv"),
        ])
    assert "SUPABASE_SERVICE_KEY" in str(exc.value)


def test_non_https_feed_url_is_refused():
    with pytest.raises(SystemExit):
        io_mod.open_text("http://example.com/feed.csv")
