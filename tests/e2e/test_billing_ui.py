"""The browser half of Premium billing (public/js/billing.js).

billing.js's decision logic is pure, so - like affiliate.js - it is exercised
directly in a loaded page with no backend (see this suite's README for why the
authenticated flows are out of scope). What these lock in:
  * billing is OFF by default: no flag, no payment button, the "not available
    yet" pop-up exactly as before
  * only *.stripe.com over https is ever navigated to
  * the Stripe-return marker is read once and stripped from the address bar
  * the plan wording for every state an Owner can be in (Free, ended, Premium,
    cancelling, payment failed, manually-granted Premium)
"""


def run(page, live_server, body):
    """Splice `body` into a function literal Playwright evaluates itself - never
    new Function() in the page, which the app's strict CSP (no 'unsafe-eval')
    rightly refuses."""
    page.goto(live_server + "/index.html")
    return page.evaluate("async () => { const m = await import('/js/billing.js'); " + body + " }")


def test_billing_is_off_by_default(page, live_server):
    r = run(page, live_server, "return { enabled: m.billingEnabled(), flag: window.SITESTOCK_BILLING };")
    assert r["enabled"] is False
    assert r["flag"] == {"enabled": False}


def test_upgrade_popup_keeps_its_not_available_yet_face_when_billing_is_off(page, live_server):
    page.goto(live_server + "/index.html")
    # The pop-up markup exists in the page even though nothing has opened it.
    assert page.locator("#premium-upgrade-mailto").count() == 1
    assert page.locator("#premium-upgrade-checkout-btn").count() == 1
    assert page.locator("#premium-upgrade-checkout-btn").get_attribute("hidden") is not None
    assert "isn't available to buy just yet" in page.locator("#premium-upgrade-hint").inner_text()


def test_only_https_stripe_hosts_are_navigable(page, live_server):
    r = run(page, live_server, """
        return {
          checkout: m.isStripeUrl('https://checkout.stripe.com/c/pay/cs_test_1'),
          portal: m.isStripeUrl('https://billing.stripe.com/p/session/x'),
          http: m.isStripeUrl('http://checkout.stripe.com/x'),
          lookalike: m.isStripeUrl('https://checkout.stripe.com.evil.example/x'),
          suffixTrick: m.isStripeUrl('https://evilstripe.com/x'),
          js: m.isStripeUrl('javascript:alert(1)'),
          nonsense: m.isStripeUrl('not a url'),
        };
    """)
    assert r["checkout"] and r["portal"]
    assert not any([r["http"], r["lookalike"], r["suffixTrick"], r["js"], r["nonsense"]])


def test_return_marker_is_read_once_and_stripped_from_the_url(page, live_server):
    # main.js's bootstrap reads the marker on page load (before any routing), so
    # by the time the test looks, the address bar is already clean and the
    # marker is waiting in memory for the Owner dashboard to show.
    page.goto(live_server + "/index.html?billing=success&keep=1")
    page.wait_for_function("() => !location.search.includes('billing')")
    r = page.evaluate("""async () => {
        const m = await import('/js/billing.js');
        return { url: location.search, take1: m.takeBillingReturn(), take2: m.takeBillingReturn() };
    }""")
    assert r["url"] == "?keep=1"          # marker gone, unrelated params untouched
    assert r["take1"] == "success"        # shown once...
    assert r["take2"] is None             # ...then never again


def test_an_unknown_return_marker_is_ignored(page, live_server):
    page.goto(live_server + "/index.html?billing=%3Cscript%3E")
    page.wait_for_function("() => !location.search.includes('billing')")
    r = page.evaluate("""async () => {
        const m = await import('/js/billing.js');
        return { taken: m.takeBillingReturn(), url: location.search };
    }""")
    assert r["taken"] is None   # stripped from the URL, but never surfaced as a message
    assert r["url"] == ""


def test_plan_wording_for_every_owner_state(page, live_server):
    r = run(page, live_server, """
        const base = { sitesUsed: 2, siteLimit: 2 };
        const end = Date.UTC(2026, 9, 23);
        return {
          free: m.planSummary({ ...base, premium: false, billing: null }),
          ended: m.planSummary({ ...base, premium: false, billing: { status: 'canceled' } }),
          active: m.planSummary({ ...base, premium: true, billing: { status: 'active', currentPeriodEnd: end, cancelAtPeriodEnd: false } }),
          cancelling: m.planSummary({ ...base, premium: true, billing: { status: 'active', currentPeriodEnd: end, cancelAtPeriodEnd: true } }),
          pastDue: m.planSummary({ ...base, premium: true, billing: { status: 'past_due', currentPeriodEnd: end, cancelAtPeriodEnd: false } }),
          manual: m.planSummary({ ...base, premium: true, billing: null }),
        };
    """)
    assert r["free"]["action"] == "upgrade" and "2 of 2 sites used" in r["free"]["text"]
    assert "ended" in r["ended"]["text"] and r["ended"]["action"] == "upgrade"
    assert r["active"]["action"] == "manage" and "Renews on 23 October 2026" in r["active"]["text"]
    assert "cancelled" in r["cancelling"]["text"] and "23 October 2026" in r["cancelling"]["text"]
    assert r["pastDue"]["tone"] == "warn" and r["pastDue"]["action"] == "manage"
    # Premium switched on by hand (no billing row) has nothing to manage in Stripe.
    assert r["manual"]["action"] is None


def test_return_notices(page, live_server):
    r = run(page, live_server, """
        return { ok: m.returnNotice('success'), no: m.returnNotice('cancelled'), portal: m.returnNotice('returned'), none: m.returnNotice(null) };
    """)
    assert "payment went through" in r["ok"]["text"] and r["ok"]["tone"] == "ok"
    assert "nothing was charged" in r["no"]["text"]
    assert r["portal"] is None and r["none"] is None


def test_checkout_refuses_to_run_when_billing_is_off(page, live_server):
    r = run(page, live_server, "return await m.startCheckout('11111111-2222-4333-8444-555555555555');")
    assert r["ok"] is False
    assert "isn't available yet" in r["error"]
