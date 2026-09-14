"""Client-side register-form validation only - never submits the form, since
a real submission needs a solved Cloudflare Turnstile challenge (impossible
in headless automation, and not what these checks are about anyway). See
PROGRESS.md's "Register-form polish" entry for the feature this guards:
Create Account must stay disabled until every password rule *and* the
terms checkbox are satisfied."""
from helpers import go_to_landing, wait_for_active_view


def _go_to_register(page, live_server):
    go_to_landing(page, live_server)
    page.click("[data-auth-target='register']")
    wait_for_active_view(page, "auth-view")
    page.wait_for_selector("#register-form:not([hidden])")


def test_submit_starts_disabled(page, live_server, console_errors):
    _go_to_register(page, live_server)
    assert page.is_disabled("#register-submit-btn")
    assert console_errors == []


def test_short_password_keeps_submit_disabled(page, live_server, console_errors):
    _go_to_register(page, live_server)
    page.fill("#register-email-input", "test@example.com")
    page.fill("#register-password-input", "short")
    page.fill("#register-confirm-input", "short")
    page.fill("#register-displayname-input", "Test Person")
    page.click("[data-role='worker']")
    page.check("#register-terms-checkbox")
    assert page.is_disabled("#register-submit-btn")
    length_rule = page.get_attribute("[data-rule='length']", "class")
    assert "met" not in length_rule
    assert console_errors == []


def test_valid_password_plus_terms_enables_submit(page, live_server, console_errors):
    _go_to_register(page, live_server)
    page.fill("#register-email-input", "test@example.com")
    # Long + unlikely-to-be-breached, so the (fail-open) HIBP check resolves
    # as "not breached" reliably regardless of the test sandbox's network
    # access to api.pwnedpasswords.com.
    password = "correct-unusual-horse-battery-9182"
    page.fill("#register-password-input", password)
    page.fill("#register-confirm-input", password)
    page.fill("#register-displayname-input", "Test Person")
    page.click("[data-role='worker']")
    page.check("#register-terms-checkbox")

    page.wait_for_function(
        "() => document.getElementById('register-submit-btn').disabled === false",
        timeout=8000,
    )
    assert console_errors == []


def test_role_toggle_reflects_selection(page, live_server, console_errors):
    _go_to_register(page, live_server)
    page.click("[data-role='owner']")
    assert page.get_attribute("[data-role='owner']", "aria-pressed") == "true"
    assert page.get_attribute("[data-role='worker']", "aria-pressed") == "false"
    assert console_errors == []
