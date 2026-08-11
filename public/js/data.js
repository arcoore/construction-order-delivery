// Mock branch network (builders' merchants). Coordinates are approximate
// city-centre locations for demo purposes, not exact street addresses.
export const BRANCHES = [
  { id: 'b1', name: 'Travis Perkins - London Wandsworth', website: 'travisperkins.co.uk', postcode: 'SW18 4ES', lat: 51.4571, lon: -0.1998 },
  { id: 'b2', name: 'Jewson - Manchester', website: 'jewson.co.uk', postcode: 'M11 4AU', lat: 53.4808, lon: -2.1749 },
  { id: 'b3', name: 'Selco - Birmingham', website: 'selcobw.com', postcode: 'B6 7DB', lat: 52.4862, lon: -1.8904 },
  { id: 'b4', name: 'Wickes Trade - Leeds', website: 'wickes.co.uk', postcode: 'LS10 1AB', lat: 53.8008, lon: -1.5491 },
  { id: 'b5', name: 'Travis Perkins - Bristol', website: 'travisperkins.co.uk', postcode: 'BS1 6XX', lat: 51.4545, lon: -2.5879 },
  { id: 'b6', name: 'Jewson - Glasgow', website: 'jewson.co.uk', postcode: 'G1 1AA', lat: 55.8642, lon: -4.2518 },
  { id: 'b7', name: 'MKM Building Supplies - Liverpool', website: 'mkmbs.co.uk', postcode: 'L1 8JQ', lat: 53.4084, lon: -2.9916 },
  { id: 'b8', name: 'Selco - Newcastle', website: 'selcobw.com', postcode: 'NE1 7RU', lat: 54.9783, lon: -1.6178 },
  { id: 'b9', name: 'Buildbase - Sheffield', website: 'buildbase.co.uk', postcode: 'S1 2HE', lat: 53.3811, lon: -1.4701 },
  { id: 'b10', name: 'Jewson - Nottingham', website: 'jewson.co.uk', postcode: 'NG1 6HA', lat: 52.9548, lon: -1.1581 },
  { id: 'b11', name: 'Travis Perkins - Cardiff', website: 'travisperkins.co.uk', postcode: 'CF10 1EP', lat: 51.4816, lon: -3.1791 },
  { id: 'b12', name: 'Buildbase - Edinburgh', website: 'buildbase.co.uk', postcode: 'EH1 1AA', lat: 55.9533, lon: -3.1883 },
];

const ALL_BRANCH_IDS = BRANCHES.map(b => b.id);

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

export function getBranch(id) {
  return BRANCHES.find(b => b.id === id);
}

export function getBranchesForProduct(product) {
  return product.branchIds.map(id => getBranch(id)).filter(Boolean);
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
