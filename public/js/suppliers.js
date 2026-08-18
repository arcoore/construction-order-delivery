// Suppliers and supplier branches — Phase B, Supabase-backed (real Postgres,
// RLS-enforced GLOBAL reference data — see
// supabase/migrations/0017_supplier_branch_foundation.sql). This is
// migrated FIXTURE/DEMO data, not merchant-verified data — see that
// migration's own header and CLAUDE.md's Phase B section before assuming
// otherwise. Moving it into Supabase does not make it live, official,
// current, or API-sourced.
//
// CACHE LIFECYCLE — same contract as sites.js/community.js (read those
// files' headers first if you haven't). Every read function here
// (getSuppliers, getSupplierBranches, getBranch, getBranchesForProduct)
// stays SYNCHRONOUS because site.js/driver.js call them inline inside
// synchronous render code that isn't being converted to async this phase.
// They read an in-memory cache kept fresh by real Supabase traffic on
// login/bootstrap/view-entry/window-focus — the exact same lifecycle every
// other data module already uses (wired into main.js's refreshDataCaches()).
// No Realtime — supplier/branch master data changes at the frequency of
// "someone edits a fixture/seed," not "multiple users collaborate on it
// live," so the existing refetch cadence is enough (see CLAUDE.md's Phase B
// section for the full reasoning; do not add these tables to the
// supabase_realtime publication).
//
// EXTERNAL ID CONTRACT — the `id` this module exposes on every branch
// object is the STABLE catalogue key (e.g. 'b1'), the exact same string
// PRODUCTS[].branchIds (data.js) and every existing order's stockist_id
// column already use — never the new supplier_branches UUID primary key,
// which stays purely internal to this module's own Supabase queries. This
// is what makes the move off data.js's hardcoded BRANCHES a drop-in
// replacement: nothing downstream (site.js's Phase A distance ranking,
// driver.js's pickup-location lookup, order creation/snapshot) had to
// change its own identifier handling at all — a branch object here has the
// exact same shape (`id`, `name`, `website`, `postcode`, `lat`, `lon`)
// data.js's BRANCHES entries always did.
import { getCurrentUserId } from './identity.js';
import { subscribeAuth } from './auth.js';
import { supabase } from './supabaseClient.js';

const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeSuppliers(fn) {
  listeners.add(fn);
  fn();
  return () => listeners.delete(fn);
}

// --- Cache ----------------------------------------------------------
let cache = { suppliers: [], branches: [] };
export let supplierCacheReady = false;

function mapSupplier(r) {
  return {
    id: r.id, // real DB UUID — fine to expose for suppliers, since nothing
              // outside this module stores a supplier id anywhere (orders
              // only ever reference a branch's catalogue_key).
    name: r.name,
    website: r.website,
  };
}

// Reconstructs the exact combined "<Supplier> - <Location>" string data.js's
// BRANCHES entries always stored as one field, from the now-separate
// suppliers.name + supplier_branches.name — so every existing render call
// site (site.js, driver.js) sees an identically-shaped string to before.
function mapBranch(r, supplierById) {
  const supplier = supplierById.get(r.supplier_id);
  return {
    id: r.catalogue_key,
    supplierId: r.supplier_id, // additive — data.js's old BRANCHES entries
                                // never had this; only getSupplierBranches()
                                // reads it, everything else still just uses
                                // id/name/website/postcode/lat/lon.
    name: supplier ? `${supplier.name} - ${r.name}` : r.name,
    website: supplier ? supplier.website : '',
    postcode: r.postcode,
    lat: r.latitude,
    lon: r.longitude,
  };
}

// Full refetch of both tables this module owns — same pattern
// refreshSitesCache() already uses. RLS scopes what actually comes back:
// only active suppliers/branches are ever visible to an authenticated read
// (supplier_branch_foundation.sql's own policies), so there is no
// client-side active-filtering to duplicate here.
export async function refreshSupplierCache() {
  const userId = getCurrentUserId();
  if (!userId) {
    cache = { suppliers: [], branches: [] };
    supplierCacheReady = true;
    notify();
    return;
  }
  const [suppliersRes, branchesRes] = await Promise.all([
    supabase.from('suppliers').select('*'),
    supabase.from('supplier_branches').select('*'),
  ]);
  const suppliers = (suppliersRes.data || []).map(mapSupplier);
  const supplierById = new Map(suppliers.map(s => [s.id, s]));
  cache = {
    suppliers,
    branches: (branchesRes.data || []).map(r => mapBranch(r, supplierById)),
  };
  supplierCacheReady = true;
  notify();
}

// Refetches on every auth transition — see community.js's identical
// subscription for why this is in addition to, not instead of, main.js's
// explicit bootstrap await.
subscribeAuth(() => { refreshSupplierCache(); });

// --- Reads ------------------------------------------------------------

export function getSuppliers() {
  return cache.suppliers;
}

export function getSupplierBranches(supplierId) {
  // Note: takes the real supplier UUID (from getSuppliers()'s own `id`
  // field), not a catalogue key — suppliers have no catalogue-key concept,
  // only branches do (see the module header).
  return cache.branches.filter(b => b.supplierId === supplierId);
}

// Called synchronously from driver.js — must stay sync, cache-backed.
// `catalogueKey` is the exact same stable id data.js's old getBranch(id)
// always took (order.stockistId, product.branchIds entries).
export function getBranch(catalogueKey) {
  return cache.branches.find(b => b.id === catalogueKey) || null;
}

// Called synchronously from site.js's Worker order-creation/edit flows —
// must stay sync, cache-backed. Mirrors data.js's old getBranchesForProduct
// exactly: maps product.branchIds (still the same catalogue-key strings,
// data.js's PRODUCTS fixture is unchanged) to full branch records,
// filtering out any that don't resolve.
export function getBranchesForProduct(product) {
  return product.branchIds.map(id => getBranch(id)).filter(Boolean);
}
