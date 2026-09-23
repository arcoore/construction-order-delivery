// Supplier offers - real merchant price / stock / product-link per
// (supplier, SiteStock product, optional variant). Supabase-backed GLOBAL
// reference data (supabase/migrations/0054_supplier_offers_and_affiliate_links.sql),
// same synchronous-facade-over-async-cache contract as suppliers.js/
// products.js: every read here is SYNCHRONOUS over an in-memory cache that
// main.js's refreshDataCaches() keeps fresh, because site.js/buyer.js call
// these inline inside synchronous render code. No Realtime - offers change at
// feed-sync frequency, not live-collaboration frequency.
//
// The table starts EMPTY and nothing here invents a price: when no offer
// exists for a (supplier, product, variant) every caller falls back to the
// product's own unit_price and labels it "indicative". Live prices appear only
// once a real feed has been imported (tools/import_offers.py).
import { getCurrentUserId } from './identity.js';
import { subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';
import { getBranch } from './suppliers.js';

let cache = { offers: [] };
export let offersCacheReady = false;

function mapOffer(r) {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    productKey: r.product_key,
    variantLabel: r.variant_label,
    externalId: r.external_id,
    title: r.title,
    unitPrice: Number(r.unit_price),
    inStock: r.in_stock,
    productUrl: r.product_url,
    imageUrl: r.image_url,
    source: r.source,
    lastSyncedAt: r.last_synced_at ? Date.parse(r.last_synced_at) : null,
  };
}

// RLS returns only live offers of live suppliers, so there is no client-side
// active-filtering to duplicate. A failed fetch leaves the previous cache in
// place (stale-but-usable beats "all prices vanished").
export async function refreshOffersCache() {
  if (!getCurrentUserId()) {
    cache = { offers: [] };
    offersCacheReady = true;
    return;
  }
  const { data, error } = await supabase.from('supplier_offers').select('*');
  if (!error) cache = { offers: (data || []).map(mapOffer) };
  offersCacheReady = true;
}

subscribeAuth(() => { refreshOffersCache(); });

export function getOfferById(id) {
  return cache.offers.find(o => o.id === id) || null;
}

// Exact variant match first, then a product-level (no-variant) offer. A custom
// free-text size never matches a variant-specific offer - correct, since we
// can't know a merchant price for a size the catalogue doesn't list.
export function findOffer(supplierId, productKey, variant) {
  if (!supplierId) return null;
  const candidates = cache.offers.filter(o => o.supplierId === supplierId && o.productKey === productKey);
  if (variant) {
    const exact = candidates.find(o => o.variantLabel === variant);
    if (exact) return exact;
  }
  return candidates.find(o => o.variantLabel == null) || null;
}

// For the price line under a product: the cheapest live price and how many
// distinct suppliers list it. With a chosen variant only offers for exactly
// that variant (or a whole-product offer) count - the cheapest price for a
// DIFFERENT size must never be shown against this one. Out-of-stock offers are
// ignored while any in-stock one exists, so "from GBP x" is never a price you
// can't actually buy at. Null = no live offers at all (callers show
// "indicative").
export function offersSummaryForProduct(productKey, variant = null) {
  let offers = cache.offers.filter(o => o.productKey === productKey);
  if (variant) offers = offers.filter(o => o.variantLabel === variant || o.variantLabel == null);
  if (offers.length === 0) return null;
  const inStock = offers.filter(o => o.inStock !== false);
  const pool = inStock.length > 0 ? inStock : offers;
  return {
    minPrice: Math.min(...pool.map(o => o.unitPrice)),
    supplierCount: new Set(pool.map(o => o.supplierId)).size,
    allOutOfStock: inStock.length === 0,
  };
}

// Re-price a set of order lines as they'd be bought from one branch's
// supplier. A line with a matching live offer takes the offer's price and
// carries its id (the server then verifies both); a line without one keeps
// whatever unitPrice it already had (indicative). Pure over the cache.
//   items: [{ productId, variant, quantity, unitPrice, ... }]
export function priceItemsForBranch(items, branchKey) {
  const branch = branchKey ? getBranch(branchKey) : null;
  const supplierId = branch ? branch.supplierId : null;
  let liveCount = 0;
  const priced = items.map(it => {
    const offer = findOffer(supplierId, it.productId, it.variant);
    if (!offer) return { ...it, offerId: null, offer: null };
    liveCount++;
    return { ...it, unitPrice: offer.unitPrice, offerId: offer.id, offer };
  });
  const total = priced.reduce((sum, it) => sum + (it.unitPrice || 0) * it.quantity, 0);
  const outOfStock = priced.filter(it => it.offer && it.offer.inStock === false).length;
  return { items: priced, liveCount, outOfStock, total, supplierId };
}

// Fire-and-forget: the Buyer's click must never wait on, or be blocked by,
// this. A failed log just means one fewer row in a reconciliation table.
export function logSupplierClick(orderId, link) {
  if (!orderId || !link) return;
  supabase.rpc('log_affiliate_click', {
    p_order_id: orderId,
    p_link_kind: link.kind,
    p_tracked: !!link.tracked,
  }).then(() => {}, () => {});
}
