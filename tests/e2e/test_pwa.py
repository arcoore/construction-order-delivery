"""PWA installability (manifest + service worker), added 2026-09-14 - see
CLAUDE.md's "PWA installability" section for the design rationale
(particularly why the service worker is deliberately network-first with no
precaching)."""
from helpers import go_to_landing


def test_manifest_is_valid_and_linked(page, live_server, console_errors):
    go_to_landing(page, live_server)
    href = page.get_attribute("link[rel='manifest']", "href")
    assert href == "manifest.webmanifest"

    manifest = page.evaluate(
        "async () => (await fetch('manifest.webmanifest')).json()"
    )
    assert manifest["name"] == "SiteStock"
    assert manifest["start_url"] == "."
    assert manifest["display"] == "standalone"
    sizes = {icon["sizes"] for icon in manifest["icons"]}
    assert {"192x192", "512x512"} <= sizes
    assert any(icon.get("purpose") == "maskable" for icon in manifest["icons"])
    assert console_errors == []


def test_manifest_icons_are_reachable(page, live_server):
    go_to_landing(page, live_server)
    manifest = page.evaluate(
        "async () => (await fetch('manifest.webmanifest')).json()"
    )
    for icon in manifest["icons"]:
        status = page.evaluate(
            "async (src) => (await fetch(src)).status", icon["src"]
        )
        assert status == 200, f"{icon['src']} did not return 200"


def test_service_worker_registers_and_stays_out_of_api_calls(page, live_server, console_errors):
    go_to_landing(page, live_server)
    page.wait_for_function(
        "async () => (await navigator.serviceWorker.getRegistrations()).length > 0",
        timeout=8000,
    )
    registrations = page.evaluate(
        "async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.scope)"
    )
    assert len(registrations) == 1

    # The fetch handler's very first check excludes non-GET and cross-origin
    # requests - confirm the source still says so, since this is the one
    # guarantee that must never regress (the worker must never sit between
    # the app and a live Supabase/API call).
    sw_source = page.evaluate("async () => (await fetch('sw.js')).text()")
    assert "req.method !== 'GET'" in sw_source
    assert "self.location.origin" in sw_source
    assert console_errors == []
