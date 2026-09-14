"""Regression coverage for the theme/dark-mode bugs found and fixed live on
2026-09-14. The footer-visibility bug in particular is the most severe of
the day's three: a single unscoped landing.css rule (bare
footer{display:none}, inherited from the original standalone project and
missed by the scoping script) hid the app's entire global footer - legal
links, the accessibility statement, the feedback button, and the dark-mode
switch itself - on every screen outside landing-view, for the whole day it
was live, with zero visible symptom inside landing-view (a more specific
rule already overrode it there). See CLAUDE.md's "Landing page" section."""
from helpers import go_to_landing, wait_for_active_view


def _go_to_auth(page, live_server):
    go_to_landing(page, live_server)
    page.click("[data-auth-target='login']")
    wait_for_active_view(page, "auth-view")


def _set_dark_mode(page, on):
    """The real checkbox (data-theme-switch) is visually hidden (opacity:0,
    1x1px) - it's the sibling .theme-switch-track/.theme-switch-thumb spans
    that render the visible toggle, both wrapped in the same <label> so a
    real click anywhere in the label toggles the checkbox natively. Clicking
    the checkbox element directly (Playwright's .check()/.uncheck()) fails
    Playwright's actionability checks against a genuinely invisible target -
    click the visible track instead, exactly like a real user would."""
    checkbox = page.locator("[data-theme-switch]")
    if checkbox.is_checked() != on:
        page.click(".theme-switch-track")
    assert checkbox.is_checked() == on
    page.click("[data-theme-save]")


def test_footer_and_theme_switch_are_actually_visible(page, live_server, console_errors):
    _go_to_auth(page, live_server)
    footer_display = page.evaluate(
        "getComputedStyle(document.querySelector('.app-footer')).display"
    )
    assert footer_display != "none"

    track = page.locator(".theme-switch-track")
    track.scroll_into_view_if_needed()
    box = track.bounding_box()
    assert box is not None
    assert box["width"] > 0 and box["height"] > 0
    assert console_errors == []


def test_dark_mode_toggle_applies_and_persists(page, live_server, console_errors):
    _go_to_auth(page, live_server)

    # Force a known starting point regardless of the OS/emulated colour
    # scheme this test happens to run under.
    _set_dark_mode(page, True)
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"

    _set_dark_mode(page, False)
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"

    page.reload()
    wait_for_active_view(page, "landing-view")
    assert page.evaluate("localStorage.getItem('sitestock_theme')") == "light"
    assert console_errors == []


def test_dark_mode_is_a_true_black_white_swap_topbar_and_orange_unchanged(
    page, live_server, console_errors
):
    """Per explicit direction 2026-09-14: plain black/white swap, --navy
    text becomes white, but the topbar and every filled orange button stay
    exactly as they were (both were already on fixed tokens that never
    varied by theme even before this change - see CLAUDE.md)."""
    _go_to_auth(page, live_server)
    _set_dark_mode(page, True)

    colors = page.evaluate(
        """() => {
            const cs = (el) => el ? getComputedStyle(el) : null;
            const topbar = cs(document.querySelector('.topbar'));
            const heading = cs(document.querySelector('#auth-view h1'));
            const loginBtn = cs(document.getElementById('login-submit-btn'));
            const body = cs(document.body);
            return {
                topbarBg: topbar && topbar.backgroundColor,
                headingColor: heading && heading.color,
                loginBtnBg: loginBtn && loginBtn.backgroundColor,
                bodyBg: body && body.backgroundColor,
            };
        }"""
    )

    # --navy-surface, fixed regardless of theme: rgb(18, 52, 74) = #12344a
    assert colors["topbarBg"] == "rgb(18, 52, 74)"
    # --orange-surface, fixed regardless of theme: rgb(189, 76, 20) = #bd4c14
    assert colors["loginBtnBg"] == "rgb(189, 76, 20)"
    # --navy in dark mode is now pure white
    assert colors["headingColor"] == "rgb(255, 255, 255)"
    # --bg in dark mode is now pure black
    assert colors["bodyBg"] == "rgb(0, 0, 0)"
    assert console_errors == []


def test_password_input_text_is_visible_in_dark_mode(page, live_server, console_errors):
    """The other real 2026-09-14 bug: .text-input set background but never
    color, so it rendered at the browser's default (dark) input text
    colour once the background went dark too - a password field a user
    could not read while typing."""
    _go_to_auth(page, live_server)
    _set_dark_mode(page, True)

    page.fill("#login-password-input", "some-test-password")
    text_color = page.evaluate(
        "getComputedStyle(document.getElementById('login-password-input')).color"
    )
    bg_color = page.evaluate(
        "getComputedStyle(document.getElementById('login-password-input')).backgroundColor"
    )
    assert text_color != bg_color
    # Must not be a dark colour sitting on the (also dark) --sink background.
    r, g, b = (int(x) for x in text_color.strip("rgb()").split(","))
    assert (r + g + b) / 3 > 150  # a light colour, not a dark one
    assert console_errors == []
