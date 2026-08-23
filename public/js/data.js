// Roadmap Step 3 — the product catalogue (PRODUCTS, searchProducts,
// getProduct, and the ALL_BRANCH_IDS seed-authoring shorthand) moved to
// Supabase-backed `products.js` (real `products`/`product_variants` tables,
// see supabase/migrations/0020_product_catalogue.sql), following the exact
// same move Phase B already made for suppliers. `searchProducts`/
// `getProduct` now live in products.js, imported by the call sites that
// need them (site.js, owner.js, buyer.js, driver.js). What's left here is
// genuinely catalogue-independent: price formatting, the still-fully-mock
// availability estimate, category icons, and small display helpers used
// well beyond the ordering flow.

export function formatPrice(amount) {
  return `£${amount.toFixed(2)}`;
}

const AVAILABILITY_OPTIONS = [
  { key: 'today', label: 'Ready for pickup today' },
  { key: 'hours', label: 'Ready for pickup in ~2 hours' },
  { key: 'tomorrow', label: 'Ready for pickup tomorrow morning' },
];

// Deterministic mock stock estimate — stable per branch+product so it doesn't
// flicker between renders, standing in for a real stock/ETA feed.
export function getAvailability(branchId, productId) {
  const seed = `${branchId}:${productId}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVAILABILITY_OPTIONS[hash % AVAILABILITY_OPTIONS.length];
}

const CATEGORY_ICONS = {
  'Timber': '🪵',
  'Building Materials': '🧱',
  'Aggregates': '⛰️',
  'Insulation': '🧊',
  'Fixings & Fasteners': '🔩',
  'Roofing': '🏠',
  'PPE': '🦺',
  'Plumbing': '🚿',
  'Tools': '🛠️',
};

export function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || '📦';
}

export function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
