// Product catalogue — Roadmap Step 3, Supabase-backed (real Postgres,
// RLS-enforced GLOBAL reference data — see
// supabase/migrations/0020_product_catalogue.sql). This is a like-for-like
// structural move of the fixture/demo catalogue that used to live
// exclusively in data.js's hardcoded `PRODUCTS` array — not a catalogue
// redesign, and not a step toward real merchant pricing (see CLAUDE.md's
// "Roadmap Step 1" section, still parked).
//
// CACHE LIFECYCLE — same contract as suppliers.js/sites.js/community.js
// (read those files' headers first if you haven't). Every read function
// here (getProducts, getProduct, searchProducts, getVariantsForProduct)
// stays SYNCHRONOUS because site.js/owner.js/buyer.js/driver.js call them
// inline inside synchronous render code that isn't being converted to async
// this phase. They read an in-memory cache kept fresh by real Supabase
// traffic on login/bootstrap/view-entry/window-focus — the exact same
// lifecycle every other reference-data module already uses (wired into
// main.js's refreshDataCaches()). No Realtime — catalogue data changes at
// the frequency of "someone edits a fixture," not "multiple users
// collaborate on it live," exactly the same reasoning suppliers.js's own
// header already documents; do not add these tables to the
// supabase_realtime publication.
//
// EXTERNAL ID CONTRACT — the `id` this module exposes on every product
// object is the STABLE catalogue key (e.g. 'p3'), the exact same string
// every existing order's product_id column already uses — never the new
// products.id UUID primary key, which stays purely internal to this
// module's own Supabase queries. This is what makes the move off data.js's
// hardcoded PRODUCTS a drop-in replacement for every existing call site
// (site.js's search/variant/order-creation flow, owner.js/buyer.js/
// driver.js's cosmetic category-icon lookups): a product object here has
// the exact same shape (`id`, `name`, `category`, `unit`, `unitPrice`,
// `keywords`, `variants`, `branchIds`) data.js's PRODUCTS entries always
// did — `variants` in particular stays a plain `string[]` in original
// display order, assembled from the separate product_variants cache, so
// site.js's variant-picker UI needed zero redesign.
//
// VARIANTS HAVE NO STABLE ID OF THEIR OWN, ON PURPOSE — unlike suppliers
// (already referenced by orders.stockist_id before Phase B), a variant has
// only ever been a plain label string, snapshotted directly into
// orders.variant (see orderLifecycle.js/migrations/0005) — there is no
// legacy variant identifier anywhere to preserve. create_order/edit_order
// (0019) are unchanged by this phase and still accept a plain variant
// string, whether it came from this module's server-backed list or from the
// Worker's own free-text "custom size" entry (site.js) — both are
// indistinguishable once stored, exactly as before this migration.
import { getCurrentUserId } from './identity.js';
import { subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeProducts(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

// --- Cache ----------------------------------------------------------
let cache = { products: [], variantsByProductId: new Map() };
export let productCacheReady = false;

function mapProduct(r) {
  return {
    id: r.catalogue_key, // stable 'p1'..'p16' — never the internal UUID
    name: r.name,
    category: r.category,
    unit: r.unit,
    unitPrice: r.unit_price,
    keywords: r.keywords || [],
    branchIds: r.branch_ids || [],
  };
}

// Full refetch of both tables this module owns — same pattern
// refreshSupplierCache()/refreshSitesCache() already use. RLS scopes what
// actually comes back: only active products/variants (with an active
// parent, for variants) are ever visible to an authenticated read
// (0020's own policies), so there is no client-side active-filtering to
// duplicate here.
export async function refreshProductsCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { products: [], variantsByProductId: new Map() };
    productCacheReady = true;
    notify();
    return;
  }
  const [productsRes, variantsRes] = await Promise.all([
    supabase.from('products').select('*'),
    supabase.from('product_variants').select('*').order('sort_order', { ascending: true }),
  ]);

  const productRows = productsRes.data || [];
  const products = productRows.map(mapProduct);

  const idByUuid = new Map(productRows.map(r => [r.id, r.catalogue_key]));
  const variantsByProductId = new Map();
  for (const v of (variantsRes.data || [])) {
    const catalogueKey = idByUuid.get(v.product_id);
    if (!catalogueKey) continue; // orphaned/inactive-parent row RLS wouldn't return anyway
    const list = variantsByProductId.get(catalogueKey) || [];
    list.push(v.label);
    variantsByProductId.set(catalogueKey, list);
  }

  cache = { products, variantsByProductId };
  productCacheReady = true;
  notify();
}

// Refetches on every auth transition — see suppliers.js's identical
// subscription for why this is in addition to, not instead of, main.js's
// explicit bootstrap await.
subscribeAuth(() => { refreshProductsCache(); });

// --- Reads ------------------------------------------------------------

// Returns every product, each with its `variants` string array already
// attached (original display order preserved via sort_order) — the exact
// shape data.js's PRODUCTS constant always had, so existing call sites
// (site.js's search/variant-selection flow) don't need to branch on how the
// data got there.
export function getProducts() {
  return cache.products.map(p => ({ ...p, variants: cache.variantsByProductId.get(p.id) || [] }));
}

// Called synchronously from site.js/owner.js/buyer.js/driver.js — must stay
// sync, cache-backed. `catalogueKey` is the exact same stable id data.js's
// old getProduct(id) always took (order.productId).
export function getProduct(catalogueKey) {
  const p = cache.products.find(p => p.id === catalogueKey);
  if (!p) return undefined;
  return { ...p, variants: cache.variantsByProductId.get(p.id) || [] };
}

// A `getVariantsForProduct` companion to `getProduct`'s inline `variants`
// field, for any call site that only needs the label list. Not required by
// any current call site (site.js reads product.variants directly, as
// before), exposed for API symmetry/clarity going forward.
export function getVariantsForProduct(catalogueKey) {
  return cache.variantsByProductId.get(catalogueKey) || [];
}

// Byte-for-byte the same scoring logic data.js's old searchProducts used —
// only the data source (this module's cache instead of a literal array)
// changed. Client-side on purpose: at catalogue-fixture scale (a few dozen
// rows), server-side/full-text search would add per-keystroke network
// latency for no present benefit — see CLAUDE.md's Roadmap Step 3 section.
export function searchProducts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return getProducts()
    .map(p => {
      const haystacks = [p.name, p.category, ...(p.keywords || [])].map(s => s.toLowerCase());
      let score = 0;
      for (const h of haystacks) {
        if (h === q) score += 100;
        else if (h.startsWith(q)) score += 50;
        else if (h.includes(q)) score += 20;
      }
      return { product: p, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.product);
}
