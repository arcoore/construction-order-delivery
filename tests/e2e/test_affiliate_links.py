"""The outbound supplier-link builder (public/js/affiliate.js).

The module is pure (no network/DOM/Supabase), so it is exercised directly in a
loaded page rather than through a logged-in flow - no backend needed, same
scope rule as the rest of this suite (see README). What these lock in:
  * the fallback ladder deep -> search -> home, and that `kind` says which was used
  * a link is never fabricated (no template = no search link, no offer URL = no deep link)
  * only https ever reaches an href (a feed-poisoned javascript: URL cannot)
  * Awin tagging switches on ONLY when publisher id + supplier merchant id both exist
  * the wrapped URL round-trips: decoding `ued` gives back the exact destination
"""

SUPPLIER = {
    "name": "Wickes Trade",
    "website": "wickes.co.uk",
    "searchUrlTemplate": "https://www.wickes.co.uk/search?text={query}",
    "affiliateNetwork": None,
    "affiliateMerchantId": None,
}


def run(page, live_server, body):
    """Evaluate `body` (statements that may use `m`, the module, and
    `supplier`) inside the loaded page. The body is spliced into a function
    literal that Playwright evaluates itself - NOT built with new Function()
    in the page, which the app's strict CSP (no 'unsafe-eval') rightly refuses."""
    page.goto(live_server + "/index.html")
    src = "async (supplier) => { const m = await import('/js/affiliate.js'); " + body + " }"
    return page.evaluate(src, SUPPLIER)


def test_deep_link_wins_and_is_untracked_without_publisher_id(page, live_server):
    r = run(page, live_server, """
        window.SITESTOCK_AFFILIATE = { awinPublisherId: '' };
        return m.resolveSupplierLink({ supplier, offer: { productUrl: 'https://www.wickes.co.uk/p/123' }, query: 'cement' });
    """)
    assert r["kind"] == "deep"
    assert r["tracked"] is False
    assert r["url"] == "https://www.wickes.co.uk/p/123"


def test_search_rung_encodes_the_query_and_needs_a_template(page, live_server):
    r = run(page, live_server, """
        window.SITESTOCK_AFFILIATE = { awinPublisherId: '' };
        const withTemplate = m.resolveSupplierLink({ supplier, query: 'Cement & sand #1 25kg' });
        const noTemplate = m.resolveSupplierLink({ supplier: { ...supplier, searchUrlTemplate: null }, query: 'cement' });
        return { withTemplate, noTemplate };
    """)
    assert r["withTemplate"]["kind"] == "search"
    assert r["withTemplate"]["url"] == "https://www.wickes.co.uk/search?text=Cement%20%26%20sand%20%231%2025kg"
    # No template -> never invent a search URL, fall through to the homepage.
    assert r["noTemplate"]["kind"] == "home"
    assert r["noTemplate"]["url"] == "https://wickes.co.uk/"


def test_homepage_is_the_last_resort_and_null_supplier_gives_nothing(page, live_server):
    r = run(page, live_server, """
        return {
          home: m.resolveSupplierLink({ supplier: { name: 'X', website: 'example.com' } }),
          none: m.resolveSupplierLink({ supplier: null }),
          noSite: m.resolveSupplierLink({ supplier: { name: 'X', website: '' } }),
        };
    """)
    assert r["home"]["kind"] == "home"
    assert r["none"] is None
    assert r["noSite"] is None


def test_non_https_urls_can_never_reach_an_href(page, live_server):
    r = run(page, live_server, """
        window.SITESTOCK_AFFILIATE = { awinPublisherId: '' };
        return {
          js: m.safeHttpsUrl('javascript:alert(1)'),
          http: m.safeHttpsUrl('http://example.com/'),
          data: m.safeHttpsUrl('data:text/html,<script>alert(1)</script>'),
          ok: m.safeHttpsUrl('https://example.com/a b'),
          // a poisoned offer URL must NOT become the link - it falls back
          poisoned: m.resolveSupplierLink({ supplier, offer: { productUrl: 'javascript:alert(1)' }, query: 'cement' }),
        };
    """)
    assert r["js"] is None and r["http"] is None and r["data"] is None
    assert r["ok"] == "https://example.com/a%20b"
    assert r["poisoned"]["kind"] == "search"  # not 'deep'
    assert "javascript" not in r["poisoned"]["url"]


def test_awin_tagging_needs_publisher_id_and_merchant_id(page, live_server):
    r = run(page, live_server, """
        const awin = { ...supplier, affiliateNetwork: 'awin', affiliateMerchantId: '4321' };
        window.SITESTOCK_AFFILIATE = { awinPublisherId: '' };
        const noPublisher = m.resolveSupplierLink({ supplier: awin, query: 'cement' });
        window.SITESTOCK_AFFILIATE = { awinPublisherId: '99999' };
        const noMerchant = m.resolveSupplierLink({ supplier, query: 'cement' });
        const tagged = m.resolveSupplierLink({ supplier: awin, query: 'cement mix', orderId: 'c0ffee00-1111-2222-3333-444455556666' });
        const u = new URL(tagged.url);
        return {
          noPublisher, noMerchant, tagged,
          host: u.host, path: u.pathname,
          mid: u.searchParams.get('awinmid'), aff: u.searchParams.get('awinaffid'),
          clickref: u.searchParams.get('clickref'), ued: u.searchParams.get('ued'),
        };
    """)
    assert r["noPublisher"]["tracked"] is False
    assert r["noMerchant"]["tracked"] is False
    assert r["tagged"]["tracked"] is True
    assert (r["host"], r["path"]) == ("www.awin1.com", "/cread.php")
    assert r["mid"] == "4321" and r["aff"] == "99999"
    assert r["clickref"] == "so-c0ffee00111122223333444455556666"
    assert len(r["clickref"]) <= 50
    # The destination survives the wrap exactly - decoding ued gives it back.
    assert r["ued"] == r["tagged"]["destination"]
    assert r["ued"] == "https://www.wickes.co.uk/search?text=cement%20mix"


def test_clickref_is_safe_and_bounded_and_empty_without_an_order(page, live_server):
    r = run(page, live_server, """
        return {
          none: m.clickRefForOrder(null),
          long: m.clickRefForOrder('x'.repeat(200)),
          dirty: m.clickRefForOrder('a b&c=d/e?f'),
        };
    """)
    assert r["none"] == ""
    assert len(r["long"]) <= 50
    assert r["dirty"] == "so-abcdef"


def test_disclosure_only_when_a_link_is_actually_tagged(page, live_server):
    r = run(page, live_server, """
        return {
          tagged: m.affiliateDisclosure({ tracked: true }),
          untagged: m.affiliateDisclosure({ tracked: false }),
          none: m.affiliateDisclosure(null),
        };
    """)
    assert "commission" in r["tagged"]
    assert r["untagged"] == "" and r["none"] == ""
