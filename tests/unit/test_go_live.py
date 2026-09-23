"""tools/go_live.py - the go-live switchboard. All edits are exercised on the REAL
public/ files (read in memory / copied to a temp tree), never written back."""
import datetime
import importlib.util
import re
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("go_live", ROOT / "tools" / "go_live.py")
gl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gl)

FILES = {k: (ROOT / "public" / k).read_text(encoding="utf-8") for k in ("privacy.html", "terms.html", "refunds.html")}
WHEN = datetime.date(2026, 10, 1)


# --------------------------------------------------------------- env.js
def test_parse_env_of_the_real_file():
    env = gl.parse_env((ROOT / "public/js/env.js").read_text(encoding="utf-8"))
    assert env["awin_publisher_id"] == ""       # no affiliate account yet
    assert env["billing_enabled"] is False      # billing dark


def test_set_awin_publisher_only_touches_that_value():
    text = (ROOT / "public/js/env.js").read_text(encoding="utf-8")
    new = gl.set_awin_publisher(text, "123456")
    assert "awinPublisherId: '123456'" in new
    assert new.replace("123456", "") == text                  # nothing else changed
    assert gl.parse_env(new)["billing_enabled"] is False      # and never touches the billing switch


@pytest.mark.parametrize("bad", ["", "12", "abc123", "123; drop table", "12345678901234"])
def test_publisher_id_must_be_digits(bad):
    with pytest.raises(SystemExit):
        gl.set_awin_publisher("awinPublisherId: ''", bad)


# --------------------------------------------------------- billing copy
def test_billing_copy_adds_stripe_everywhere_it_is_needed():
    out = gl.apply_billing_copy(FILES, WHEN)
    p, t, r = out["privacy.html"], out["terms.html"], out["refunds.html"]
    assert p.count("Stripe") >= 6
    for marker in ("collect", "row", "detail", "retention"):
        assert f"billing-copy:start:{marker}" in p and f"billing-copy:end:{marker}" in p
    assert "never sees or stores card" in p or "never see" in p
    assert "£10" in t.replace("&pound;", "£") and "renews automatically" in t and "Manage subscription" in t
    assert "we do not currently take" not in t and "not yet possible to buy" not in t
    assert "Premium costs" in r and "currently free" not in r and "If paid plans are introduced" not in r
    for text in (p, t, r):
        assert "Last updated 1 October 2026" in text


def test_billing_copy_is_idempotent():
    once = gl.apply_billing_copy(FILES, WHEN)
    twice = gl.apply_billing_copy(once, datetime.date(2027, 1, 1))
    assert twice == once   # a second run changes nothing (not even the date)


def test_billing_copy_keeps_the_pages_well_formed():
    out = gl.apply_billing_copy(FILES, WHEN)
    for name, text in out.items():
        for tag in ("div", "ul", "dl", "table", "tbody", "tr", "li", "dd", "dt"):
            assert len(re.findall(rf"<{tag}[\s>]", text)) == len(re.findall(rf"</{tag}>", text)), f"{name}: unbalanced <{tag}>"


def test_the_processor_table_row_has_three_cells_like_its_neighbours():
    p = gl.apply_billing_copy(FILES, WHEN)["privacy.html"]
    row = re.search(r"billing-copy:start:row -->(.*?)<!-- billing-copy:end:row", p, re.S).group(1)
    assert row.count("<td>") == 3 and row.count("</td>") == 3


def test_billing_copy_refuses_when_a_page_changed_shape():
    broken = dict(FILES, **{"terms.html": FILES["terms.html"].replace("<h2>10. Fees, cancellation and refunds</h2>", "<h2>Fees</h2>")})
    with pytest.raises(SystemExit):
        gl.apply_billing_copy(broken, WHEN)


# ------------------------------------------------------------- operator
def test_operator_swap_replaces_every_mention_and_escapes_html():
    n_before = sum(gl.read(ROOT, rel).count(gl.OLD_NAME) for rel in gl.OPERATOR_FILES)
    assert n_before >= 5
    swapped = "".join(gl.swap_operator(gl.read(ROOT, rel), "Jane <b>Smith</b>", "1 High St, Leeds, LS1 1AA") for rel in gl.OPERATOR_FILES)
    assert gl.OLD_NAME not in swapped and gl.OLD_ADDRESS not in swapped
    assert "Jane &lt;b&gt;Smith&lt;/b&gt;" in swapped and "<b>Smith" not in swapped


def test_operator_swap_leaves_the_email_alone_unless_asked():
    text = gl.read(ROOT, "public/privacy.html")
    assert gl.OLD_EMAIL in text
    assert gl.OLD_EMAIL in gl.swap_operator(text, "Jane Smith", "1 High St")
    assert gl.OLD_EMAIL not in gl.swap_operator(text, email="hello@example.co.uk")


# ---------------------------------------------------------------- check
def test_check_reports_the_current_reality_offline(capsys):
    rc = gl.run_check(ROOT, offline=True, no_db=True)
    out = capsys.readouterr().out
    assert rc == 0
    assert "Awin publisher id in env.js: not set" in out
    assert "Billing switch in env.js: off" in out
    assert "not applied yet" in out   # Stripe wording not in the repo copy of the pages


def test_check_flags_a_billing_switch_that_leads_its_dependencies(tmp_path, capsys):
    (tmp_path / "public" / "js").mkdir(parents=True)
    shutil.copy(ROOT / "public/js/env.js", tmp_path / "public/js/env.js")
    for f in ("privacy.html", "terms.html", "refunds.html"):
        shutil.copy(ROOT / "public" / f, tmp_path / "public" / f)
    env = tmp_path / "public/js/env.js"
    env.write_text(env.read_text(encoding="utf-8").replace("SITESTOCK_BILLING = { enabled: false }", "SITESTOCK_BILLING = { enabled: true }"), encoding="utf-8")
    rc = gl.run_check(tmp_path, offline=True, no_db=True)
    out = capsys.readouterr().out
    assert rc == 1
    assert "Billing is ON" in out and "Stripe wording" in out


# ------------------------------------------------------------ CLI safety
def test_awin_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    before = (ROOT / "public/js/env.js").read_text(encoding="utf-8")
    rc = gl.main(["awin", "--publisher-id", "424242", "--merchant", "Wickes Trade=999"])
    out = capsys.readouterr().out
    assert rc == 0
    assert (ROOT / "public/js/env.js").read_text(encoding="utf-8") == before
    assert "affiliate_merchant_id = '999' where name = 'Wickes Trade'" in out and "dry run" in out


def test_awin_rejects_unknown_suppliers_and_non_numeric_merchant_ids():
    with pytest.raises(SystemExit):
        gl.main(["awin", "--publisher-id", "424242", "--merchant", "Acme Bricks=1"])
    with pytest.raises(SystemExit):
        gl.main(["awin", "--publisher-id", "424242", "--merchant", "Wickes Trade=1'; drop table x;--"])


def test_billing_copy_dry_run_writes_nothing(capsys):
    before = {k: (ROOT / "public" / k).read_text(encoding="utf-8") for k in FILES}
    assert gl.main(["billing-copy"]) == 0
    assert {k: (ROOT / "public" / k).read_text(encoding="utf-8") for k in FILES} == before
