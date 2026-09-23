// Outbound supplier links - the one place that decides where a "buy this at
// the supplier" click goes, and whether it carries an affiliate tag.
//
// PURE on purpose: no network, no DOM, no Supabase. Everything it needs is
// passed in (the supplier record, an optional offer, a search query, an order
// id) or read from the public config global window.SITESTOCK_AFFILIATE, so it
// can be unit-tested in a bare page (tests/e2e/test_affiliate_links.py).
//
// THE FALLBACK LADDER - a link is always produced if the supplier has any
// website at all, in this order, and `kind` says which rung was used so the UI
// can be honest about what the link does:
//   'deep'   - the merchant's own product page (an offer with a product URL,
//              which only ever comes from a real merchant feed)
//   'search' - the merchant's site search for the item (only when the
//              supplier row carries a verified search_url_template)
//   'home'   - the merchant's homepage (what SiteStock has always done)
//
// AFFILIATE TAGGING - when the supplier is on a network we support AND we have
// a publisher id, the chosen destination is wrapped in that network's
// deep-link redirect. Today that is Awin only:
//   https://www.awin1.com/cread.php?awinmid=<merchant>&awinaffid=<publisher>
//        &clickref=<ref>&ued=<url-encoded destination>
// With no publisher id configured (the current state - no affiliate account
// yet) nothing is wrapped and `tracked` is false: the link still goes to the
// right place, just untagged. Setting window.SITESTOCK_AFFILIATE.awinPublisherId
// in env.js is the whole "turn it on" step.
//
// Nothing here ever fabricates a URL: a search link exists only if the
// supplier row has a template, a deep link only if an offer row has one.

function config() {
  return (typeof window !== 'undefined' && window.SITESTOCK_AFFILIATE) || {};
}

// Only https URLs are ever rendered into an href. Offer/supplier URLs come
// from an external feed, so a javascript:/data: value must be impossible to
// reach an <a> even if a bad row somehow got past the database CHECK.
export function safeHttpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function trackingConfigured(supplier) {
  return !!(
    supplier
    && supplier.affiliateNetwork === 'awin'
    && supplier.affiliateMerchantId
    && config().awinPublisherId
  );
}

// Awin clickref: <= 50 chars, [A-Za-z0-9_-]. Carries the SiteStock order id so
// a commission report can be matched back to an order. Empty when there is no
// order (the Worker's pre-order browsing link).
export function clickRefForOrder(orderId) {
  if (!orderId) return '';
  const compact = String(orderId).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  return compact ? `so-${compact}` : '';
}

function wrapAwin(supplier, destination, clickRef) {
  let url = 'https://www.awin1.com/cread.php'
    + `?awinmid=${encodeURIComponent(supplier.affiliateMerchantId)}`
    + `&awinaffid=${encodeURIComponent(config().awinPublisherId)}`;
  if (clickRef) url += `&clickref=${encodeURIComponent(clickRef)}`;
  return `${url}&ued=${encodeURIComponent(destination)}`;
}

// supplier: { name, website, affiliateNetwork?, affiliateMerchantId?, searchUrlTemplate? }
// offer:    { productUrl? } | null
// query:    text for the merchant-search rung (a product name)
// orderId:  optional, becomes the clickref
export function resolveSupplierLink({ supplier, offer = null, query = '', orderId = null }) {
  if (!supplier) return null;

  let destination = null;
  let kind = null;

  const deep = offer && offer.productUrl ? safeHttpsUrl(offer.productUrl) : null;
  if (deep) {
    destination = deep;
    kind = 'deep';
  } else if (supplier.searchUrlTemplate && query) {
    const filled = supplier.searchUrlTemplate.replace('{query}', encodeURIComponent(String(query).trim()));
    const safe = safeHttpsUrl(filled);
    if (safe) { destination = safe; kind = 'search'; }
  }
  if (!destination && supplier.website) {
    const home = safeHttpsUrl(`https://${supplier.website}`);
    if (home) { destination = home; kind = 'home'; }
  }
  if (!destination) return null;

  const tracked = trackingConfigured(supplier);
  const url = tracked ? wrapAwin(supplier, destination, clickRefForOrder(orderId)) : destination;
  return { url, kind, tracked, destination };
}

// Short, honest link text for each rung.
export function linkLabel(kind, supplierName) {
  const name = String(supplierName || 'the supplier').split(' - ')[0];
  if (kind === 'deep') return `View this product at ${name} ↗`;
  if (kind === 'search') return `Search ${name} for this item ↗`;
  return `Open ${name}'s website ↗`;
}

// One sentence saying what the link does, so nobody is left guessing why they
// landed on a homepage rather than a product.
export function linkHint(kind) {
  if (kind === 'deep') return 'Opens this exact product on the supplier\'s site.';
  if (kind === 'search') return 'Opens a search on the supplier\'s site for this item.';
  return 'Opens the supplier\'s website - SiteStock doesn\'t have a direct product link for this item yet.';
}

// Shown only when a link actually carries an affiliate tag. Required
// transparency for affiliate links, and true: it doesn't change the price.
export function affiliateDisclosure(link) {
  if (!link || !link.tracked) return '';
  return 'SiteStock may earn a commission if you buy through this link. It doesn\'t change your price.';
}
