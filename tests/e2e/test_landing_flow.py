"""Regression coverage for the landing-page bugs found and fixed live on
2026-09-14 (see CLAUDE.md's "Landing page" section for the full story of
each) - these are the highest-value tests in this suite because every one
of them reproduces a bug that actually shipped to production undetected
until a real user hit it."""
from helpers import go_to_landing, wait_for_active_view


def test_get_started_opens_info_page_not_auth_directly(page, live_server, console_errors):
    """The header's "Get Started for Free" pill must open the restored
    info page (data-page-target="start"), not jump straight to auth - see
    "The 'Get Started for Free' info page is back" in CLAUDE.md."""
    go_to_landing(page, live_server)
    page.click(".site-header nav [data-page-target='start']")
    page.wait_for_selector("#site-layer.is-open")
    assert "auth-view" not in (page.get_attribute("#auth-view", "class") or "")
    assert console_errors == []


def test_start_page_cta_reaches_real_auth_view(page, live_server, console_errors):
    """The CTA *inside* the restored info page is the one exception that
    still goes straight to auth (data-auth-target="register") - confirms
    the whole point of restoring the page (a real path to signup) works."""
    go_to_landing(page, live_server)
    page.click(".site-header nav [data-page-target='start']")
    page.wait_for_selector("#site-layer.is-open")
    page.click("#site-layer .start-page .problem-page-actions button[data-auth-target='register']")
    wait_for_active_view(page, "auth-view")
    active_tab = page.get_attribute("#auth-tabs [aria-current='true']", "data-auth-tab")
    assert active_tab == "register"
    assert console_errors == []


def test_overlay_scroll_and_close_still_work_after_reaching_auth(page, live_server, console_errors):
    """The real bug (2026-09-14): the start-page CTA above skipped
    landing.js's closeInternalPage(), leaving body.layer-open's
    overflow:hidden permanently stuck - breaking scroll for the rest of
    the session, auth form included. Locks in both of that bug's fixes
    (landing.js closing on any data-auth-target click, and main.js's
    showOnly() defensively stripping the class on any non-landing view)."""
    go_to_landing(page, live_server)
    page.click(".site-header nav [data-page-target='start']")
    page.wait_for_selector("#site-layer.is-open")
    page.click("#site-layer .start-page .problem-page-actions button[data-auth-target='register']")
    wait_for_active_view(page, "auth-view")

    body_overflow = page.evaluate("getComputedStyle(document.body).overflow")
    has_layer_open = page.evaluate("document.body.classList.contains('layer-open')")
    assert body_overflow == "visible"
    assert has_layer_open is False
    assert console_errors == []


def test_how_it_works_overlay_is_actually_interactive(page, live_server, console_errors):
    """The other real bug (2026-09-14): setBackgroundInert() marked
    main#app inert, which also disabled the #site-layer overlay living
    inside it - the overlay rendered but ate every click/scroll. A real
    click that lands on content inside the overlay (not falling through to
    <body>) is the actual regression guard; a class/flag check alone
    wouldn't have caught the original bug, since it wasn't about CSS
    state, it was about which element real hit-testing resolved to."""
    go_to_landing(page, live_server)
    page.click(".site-header nav [data-page-target='how']")
    page.wait_for_selector("#site-layer.is-open")

    heading = page.locator(".site-layer-body h2, .site-layer-body h3").first
    heading.wait_for(state="visible")
    box = heading.bounding_box()
    hit_inside_overlay = page.evaluate(
        """([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return document.getElementById('site-layer').contains(el);
        }""",
        [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2],
    )
    assert hit_inside_overlay is True
    assert console_errors == []


def test_close_button_returns_to_home_and_restores_scroll(page, live_server, console_errors):
    go_to_landing(page, live_server)
    page.click(".site-header nav [data-page-target='problems']")
    page.wait_for_selector("#site-layer.is-open")
    # [data-layer-close] matches two elements - the click-outside-to-close
    # scrim (.site-layer-scrim, an unsized backdrop with nothing to click in
    # a real user's terms) and the actual visible "x" button
    # (.site-layer-close) - target the real button explicitly.
    page.click(".site-layer-close")
    page.wait_for_function("() => document.getElementById('site-layer').hidden === true")
    assert page.evaluate("document.body.classList.contains('layer-open')") is False
    assert console_errors == []
