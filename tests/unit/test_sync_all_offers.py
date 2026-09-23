"""tools/sync_all_offers.py - the scheduled wrapper around the importer."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("sync_all_offers", ROOT / "tools" / "sync_all_offers.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def test_slug():
    assert sync.slug("Wickes Trade") == "wickes-trade"
    assert sync.slug("MKM Building Supplies") == "mkm-building-supplies"
    assert sync.slug("  Travis  Perkins!! ") == "travis-perkins"


def test_inert_without_configuration(capsys):
    assert sync.main(env={}, run=lambda a: (_ for _ in ()).throw(AssertionError("must not run"))) == 0
    assert "nothing to sync" in capsys.readouterr().out


def test_bad_json_and_wrong_shape_are_errors_not_silent():
    boom = lambda a: (_ for _ in ()).throw(AssertionError("must not run"))
    assert sync.main(env={"OFFER_FEEDS": "{not json"}, run=boom) == 2
    assert sync.main(env={"OFFER_FEEDS": "[1,2]"}, run=boom) == 2
    assert sync.main(env={"OFFER_FEEDS": "{}"}, run=boom) == 2


def test_missing_mapping_file_fails_that_supplier_but_others_still_run(tmp_path):
    (tmp_path / "jewson.map.csv").write_text("external_id,product_key,variant_label\nA,p1,\n", encoding="utf-8")
    calls = []
    rc = sync.main(
        env={"OFFER_FEEDS": '{"Wickes Trade": "https://f/w", "Jewson": "https://f/j"}'},
        feeds_dir=tmp_path,
        run=lambda argv: calls.append(argv) or 0,
    )
    assert rc == 1  # Wickes had no mapping -> overall red
    assert len(calls) == 1 and calls[0][:2] == ["--supplier", "Jewson"]
    assert calls[0][calls[0].index("--map") + 1].endswith("jewson.map.csv")


def test_an_importer_refusal_is_reported_without_leaking_the_feed_url(tmp_path, capsys):
    (tmp_path / "jewson.map.csv").write_text("external_id,product_key,variant_label\nA,p1,\n", encoding="utf-8")

    def refuse(argv):
        raise SystemExit("refusing to sync 0 rows")

    rc = sync.main(env={"OFFER_FEEDS": '{"Jewson": "https://secret.example/apikey/123"}'}, feeds_dir=tmp_path, run=refuse)
    err = capsys.readouterr().err
    assert rc == 1
    assert "refusing to sync 0 rows" in err
    assert "apikey/123" not in err


def test_unexpected_exception_never_prints_the_url(tmp_path, capsys):
    (tmp_path / "jewson.map.csv").write_text("external_id,product_key,variant_label\nA,p1,\n", encoding="utf-8")

    def blow_up(argv):
        raise ConnectionError("failed talking to https://secret.example/apikey/123")

    rc = sync.main(env={"OFFER_FEEDS": '{"Jewson": "https://secret.example/apikey/123"}'}, feeds_dir=tmp_path, run=blow_up)
    err = capsys.readouterr().err
    assert rc == 1
    assert "ConnectionError" in err
    assert "apikey/123" not in err
