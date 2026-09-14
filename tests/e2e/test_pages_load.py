"""Every standalone page (the SPA entry point + the 7 static legal/info
pages) loads with a 200 and no genuine console errors. Cheap, broad
coverage - this is exactly the class of check that would have caught the
dead script.js 404 found and removed 2026-09-14 (see CLAUDE.md's PWA
installability section)."""
import pytest

from helpers import go_to_landing

STATIC_PAGES = [
    "terms.html",
    "privacy.html",
    "eula.html",
    "dmca.html",
    "refunds.html",
    "accessibility.html",
    "404.html",
]


def test_index_loads_to_landing(page, live_server, console_errors):
    go_to_landing(page, live_server)
    assert page.title() != ""
    assert console_errors == []


@pytest.mark.parametrize("path", STATIC_PAGES)
def test_static_page_loads_clean(page, live_server, console_errors, path):
    response = page.goto(f"{live_server}/{path}")
    # 404.html is deliberately served with a 200 by GitHub Pages / most
    # static hosts when requested directly (it's the *fallback* page, not
    # a "this URL is broken" response) - dev_server.py does the same since
    # it's a plain file server, so 200 is the correct expectation here too.
    assert response.status == 200
    assert page.title() != ""
    if path == "404.html":
        # 404.html deliberately hardcodes every asset path as an absolute
        # /construction-order-delivery/... URL, on purpose - GitHub Pages
        # serves this exact file for ANY unmatched path anywhere on the
        # site, so a relative path would resolve against whatever mistyped
        # URL triggered the 404, not this file's own location. That only
        # resolves correctly on the real production subpath; dev_server.py
        # serves public/ at the root with no such prefix, so every one of
        # those asset requests 404s locally. Known, expected, local-only -
        # not a real bug, so this one page is exempt from the console-clean
        # assertion the rest of the suite holds every page to.
        return
    assert console_errors == []


def test_unknown_path_serves_404_page(page, live_server, console_errors):
    response = page.goto(f"{live_server}/this-page-does-not-exist")
    # dev_server.py is a plain stdlib file server with no SPA-fallback
    # rewriting (unlike GitHub Pages, which serves 404.html for any unknown
    # path) - a genuine 404 status here is correct for local dev, this test
    # just pins that known difference rather than assuming parity.
    assert response.status == 404
