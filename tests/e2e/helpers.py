"""Small shared helpers for driving the SPA the same way a real user would -
through real clicks/navigation, not by poking internal JS state. Mirrors the
click-through style CLAUDE.md's own Conventions section asks for when
verifying changes by hand (javascript_tool + get_page_text), just captured
as a repeatable test instead of a one-off session."""


def wait_for_active_view(page, view_id, timeout=8000):
    """Waits until #<view_id> carries the .active class - main.js's
    showOnly() toggles this on every route change, including the initial
    bootstrap -> landing/auth resolution."""
    page.wait_for_function(
        "(id) => document.getElementById(id)?.classList.contains('active')",
        arg=view_id,
        timeout=timeout,
    )


def go_to_landing(page, base_url):
    page.goto(base_url + "/")
    wait_for_active_view(page, "landing-view")
