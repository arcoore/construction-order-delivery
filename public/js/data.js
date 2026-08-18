// Phase B — the branch network (builders' merchants) moved to Supabase-
// backed `suppliers.js` (real `suppliers`/`supplier_branches` tables, see
// supabase/migrations/0017_supplier_branch_foundation.sql). The former
// `BRANCHES` array, `getBranch`, and `getBranchesForProduct` that lived here
// are gone — `getBranchesForProduct` now lives in `suppliers.js`, imported
// by the two call sites that need it (site.js, driver.js). This literal
// list of catalogue keys ('b1'..'b12') is the one remaining link between
// this file and that table: it must stay in sync with
// supplier_branches.catalogue_key, since PRODUCTS below still reference
// branches by these same stable string ids, exactly as they always have.
const ALL_BRANCH_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12'];

// Mock product catalog. `keywords` widen the search match beyond the name.
// Every product defines `variants` (the size/type choice) — the ordering
// flow always asks for the material first, then the exact size, for every
// item, with no exceptions.
export const PRODUCTS = [
  {
    id: 'p1', name: 'Treated Timber Fence Post', category: 'Timber',
    unit: 'each', unitPrice: 8.50, keywords: ['post', 'fence', 'wood', 'timber'],
    variants: ['75x75mm x 2.4m', '100x100mm x 1.8m', '100x100mm x 2.4m', '100x100mm x 3.0m'],
    branchIds: ['b1', 'b2', 'b4', 'b5', 'b9'],
  },
  {
    id: 'p2', name: 'Rebar Reinforcement Bar', category: 'Building Materials',
    unit: 'length', unitPrice: 6.20, keywords: ['rebar', 'steel', 'reinforcement', 'concrete'],
    variants: ['8mm x 6m', '10mm x 6m', '12mm x 6m', '10mm x 12m'],
    branchIds: ['b1', 'b3', 'b6', 'b8'],
  },
  {
    id: 'p3', name: 'General Purpose Cement', category: 'Building Materials',
    unit: 'bag', unitPrice: 6.75, keywords: ['cement', 'concrete', 'mortar'],
    variants: ['10kg bag', '25kg bag'],
    branchIds: ALL_BRANCH_IDS,
  },
  {
    id: 'p4', name: 'Building Sand', category: 'Aggregates',
    unit: 'bag', unitPrice: 4.50, keywords: ['sand', 'aggregate', 'ballast'],
    variants: ['25kg bag', 'Bulk bag (~800kg)'],
    branchIds: ['b1', 'b3', 'b5', 'b7', 'b9', 'b11'],
  },
  {
    id: 'p5', name: 'Plasterboard', category: 'Building Materials',
    unit: 'sheet', unitPrice: 9.20, keywords: ['plasterboard', 'drywall', 'gypsum'],
    variants: ['2400x1200x9.5mm', '2400x1200x12.5mm', '3000x1200x12.5mm'],
    branchIds: ['b1', 'b2', 'b4', 'b6', 'b10'],
  },
  {
    id: 'p6', name: 'Loft Insulation Roll', category: 'Insulation',
    unit: 'roll', unitPrice: 22.00, keywords: ['insulation', 'loft', 'mineral wool'],
    variants: ['100mm', '150mm', '200mm'],
    branchIds: ['b2', 'b4', 'b6', 'b8', 'b10', 'b12'],
  },
  {
    id: 'p7', name: 'OSB3 Board', category: 'Timber',
    unit: 'sheet', unitPrice: 14.50, keywords: ['osb', 'board', 'sheathing', 'wood'],
    variants: ['9mm 2440x1220mm', '11mm 2440x1220mm', '18mm 2440x1220mm'],
    branchIds: ['b1', 'b3', 'b5', 'b7', 'b9'],
  },
  {
    id: 'p8', name: 'Wood Screws', category: 'Fixings & Fasteners',
    unit: 'box', unitPrice: 5.30, keywords: ['screws', 'fixings', 'fasteners'],
    variants: ['4x40mm (Box of 200)', '5x100mm (Box of 100)', '6x120mm (Box of 50)'],
    branchIds: ALL_BRANCH_IDS,
  },
  {
    id: 'p9', name: 'Concrete Blocks', category: 'Building Materials',
    unit: 'each', unitPrice: 1.35, keywords: ['block', 'concrete block', 'blockwork'],
    variants: ['7N 440x215x100mm', '7N 440x215x140mm', '10N 440x215x100mm'],
    branchIds: ['b1', 'b2', 'b3', 'b4', 'b5'],
  },
  {
    id: 'p10', name: 'Concrete Roof Tiles', category: 'Roofing',
    unit: 'each', unitPrice: 1.10, keywords: ['roof', 'tile', 'roofing'],
    variants: ['Interlocking - Slate Grey', 'Interlocking - Terracotta', 'Plain Tile - Red'],
    branchIds: ['b3', 'b5', 'b7', 'b9', 'b11'],
  },
  {
    id: 'p11', name: 'Hi-Vis Safety Vest', category: 'PPE',
    unit: 'each', unitPrice: 3.25, keywords: ['hi-vis', 'vest', 'ppe', 'safety'],
    variants: ['S', 'M', 'L', 'XL'],
    branchIds: ALL_BRANCH_IDS,
  },
  {
    id: 'p12', name: 'Safety Helmet', category: 'PPE',
    unit: 'each', unitPrice: 7.80, keywords: ['helmet', 'hard hat', 'ppe', 'safety'],
    variants: ['White', 'Yellow', 'Orange', 'Blue'],
    branchIds: ALL_BRANCH_IDS,
  },
  {
    id: 'p13', name: 'Copper Pipe', category: 'Plumbing',
    unit: 'length', unitPrice: 11.40, keywords: ['pipe', 'copper', 'plumbing'],
    variants: ['15mm x 3m', '22mm x 3m', '28mm x 3m'],
    branchIds: ['b2', 'b4', 'b6', 'b8', 'b10'],
  },
  {
    id: 'p14', name: 'Cordless Combi Drill', category: 'Tools',
    unit: 'each', unitPrice: 89.00, keywords: ['drill', 'tool', 'cordless', 'power tool'],
    variants: ['18V - Body Only', '18V - 1 Battery Kit', '18V - 2 Battery Kit'],
    branchIds: ['b1', 'b3', 'b5', 'b7', 'b9', 'b11'],
  },
  {
    id: 'p15', name: 'PVC Waste Pipe', category: 'Plumbing',
    unit: 'length', unitPrice: 8.90, keywords: ['pipe', 'pvc', 'waste', 'drainage'],
    variants: ['32mm x 3m', '40mm x 3m', '110mm x 3m'],
    branchIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
  },
  {
    id: 'p16', name: 'MDF Board', category: 'Timber',
    unit: 'sheet', unitPrice: 13.20, keywords: ['mdf', 'board', 'wood'],
    variants: ['12mm 2440x1220mm', '18mm 2440x1220mm', '25mm 2440x1220mm'],
    branchIds: ['b2', 'b4', 'b6', 'b8'],
  },
];

export function formatPrice(amount) {
  return `£${amount.toFixed(2)}`;
}

export function searchProducts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PRODUCTS
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

export function getProduct(id) {
  return PRODUCTS.find(p => p.id === id);
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
