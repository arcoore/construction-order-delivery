-- Roadmap Step 3 — server-backed product catalogue. Moves the hardcoded
-- `PRODUCTS` fixture that used to live exclusively in public/js/data.js into
-- two real Postgres tables, `products`/`product_variants`, as GLOBAL
-- SiteStock reference data (not scoped to any community) — following the
-- exact same architecture Phase B already established for
-- suppliers/supplier_branches (0017_supplier_branch_foundation.sql /
-- 0018_supplier_parent_activity.sql): global reference data, active-only RLS
-- for authenticated reads, no write grant to authenticated at all, no
-- Realtime, no admin UI. See that migration's own header and CLAUDE.md's
-- "Phase B" section for the reasoning this migration reuses rather than
-- re-deriving.
--
-- THIS IS A LIKE-FOR-LIKE STRUCTURAL MOVE, NOT A CATALOGUE REDESIGN. Every
-- product/variant row seeded below is transcribed byte-for-byte from
-- data.js's PRODUCTS literal as it stood immediately before this migration —
-- same names, same categories, same units, same prices, same keywords, same
-- branchIds, same variant strings, same variant order. No product added, no
-- product removed, no price changed, no merchant contacted.
--
-- CATALOGUE-KEY COMPATIBILITY — products.catalogue_key holds the exact same
-- stable string identifiers ('p1'..'p16') that orders.product_id already
-- stores (see 0005_orders_and_events.sql: `product_id text not null`, a
-- plain column with no FK to any catalogue table). The new products.id UUID
-- is purely this table's own internal primary key — nothing outside
-- public/js/products.js ever sees or stores it, exactly mirroring how
-- supplier_branches.id stays internal to suppliers.js. This means zero
-- change to the orders table, zero backfill, and every historical order's
-- product_id keeps resolving correctly whether it was placed before or
-- after this migration.
--
-- VARIANTS NEVER HAD A PERSISTED ID — unlike suppliers (whose branches were
-- already referenced by orders.stockist_id before this move), a variant has
-- only ever been a plain display-label string, directly snapshotted into
-- orders.variant (also a plain `text` column, 0005). There is no legacy
-- variant identifier anywhere to preserve, so product_variants gets a
-- perfectly ordinary internal UUID PK and no public catalogue_key of its
-- own — the frontend-facing "variant" concept remains exactly what it
-- already is: a label string, chosen from the server-backed list or typed
-- as free-text custom size, either way ending up as a plain order.variant
-- string. See public/js/products.js for how the label list is exposed.
--
-- PRICING TRUST BOUNDARY UNCHANGED — moving unit_price into a real column
-- does not make it a server-verified merchant price. It is still exactly as
-- demo/fixture as data.js's old hardcoded value was; create_order/edit_order
-- (0019) are NOT modified by this migration and continue to accept
-- unit_price as client-supplied input, non-negativity-checked and
-- total-price-recomputed server-side, same as before. Real merchant pricing
-- remains parked (see CLAUDE.md's "Roadmap Step 1" section) — this
-- migration is the catalogue-location move only, not the trusted-pricing
-- phase.

create table products (
  id            uuid primary key default gen_random_uuid(),
  catalogue_key text not null unique,
  name          text not null,
  category      text not null,
  unit          text not null,
  unit_price    numeric not null,
  keywords      text[] not null default '{}',
  branch_ids    text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (unit_price >= 0)
);

-- `label` is the exact display string ('10kg bag', 'S', 'White', etc.) —
-- the same string that was previously one entry of PRODUCTS[].variants and
-- is, unchanged, what ends up snapshotted into orders.variant when chosen.
-- `sort_order` preserves the original array position: without an explicit
-- ordering column, a plain SELECT gives no guarantee of returning rows in
-- seed order, and the exact displayed variant sequence (e.g. "10kg bag"
-- before "25kg bag") is real existing UI behavior worth preserving
-- deliberately rather than leaving to incidental physical row order.
create table product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products (id) on delete restrict,
  label       text not null,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (product_id, label)
);

create index product_variants_product_idx on product_variants (product_id);

-- ---------------------------------------------------------------- RLS
-- Global reference data — same treatment as suppliers/supplier_branches:
-- authenticated users get read-only access to ACTIVE rows only, enforced at
-- the RLS layer itself. No INSERT/UPDATE/DELETE grant to `authenticated` at
-- all, and none is granted below — there is no catalogue-administration
-- feature in this app, so none is invented here; the only writer for this
-- phase is this migration's own seed. No grant to `anon` either — the
-- catalogue is never needed before login (the Worker order flow is only
-- reachable after auth + community entry), matching suppliers' precedent
-- exactly rather than inventing a new access rule.
--
-- THE PARENT-ACTIVE LESSON, APPLIED FROM THE START (not deferred to a
-- follow-up hardening migration the way Phase B's 0017 originally missed
-- it, fixed only in 0018): a variant is visible to an authenticated read
-- only if BOTH it and its parent product are active. Written correctly here
-- in 0020 itself.

alter table products enable row level security;
alter table product_variants enable row level security;

grant select on products to authenticated;
grant select on product_variants to authenticated;
-- no grant to anon at all — matches supplier_branch_foundation's default-deny
-- for unauthenticated access; anon gets no base table privilege here, so a
-- query fails at the grant check before RLS is even evaluated.

create policy products_select_active on products
  for select to authenticated using (active = true);

create policy product_variants_select_active on product_variants
  for select to authenticated using (
    active = true
    and exists (
      select 1 from products p
      where p.id = product_variants.product_id
        and p.active = true
    )
  );

-- no insert/update/delete policy on either table for any role — intentional.

-- ---------------------------------------------------------------- seed
-- 16 products, 50 variants — the exact fixture set that lived in data.js's
-- PRODUCTS array immediately before this migration. sort_order mirrors each
-- variant's zero-based position in its original array literal.

insert into products (catalogue_key, name, category, unit, unit_price, keywords, branch_ids) values
  ('p1',  'Treated Timber Fence Post', 'Timber',              'each',   8.50,  array['post','fence','wood','timber'],           array['b1','b2','b4','b5','b9']),
  ('p2',  'Rebar Reinforcement Bar',   'Building Materials',  'length', 6.20,  array['rebar','steel','reinforcement','concrete'], array['b1','b3','b6','b8']),
  ('p3',  'General Purpose Cement',    'Building Materials',  'bag',    6.75,  array['cement','concrete','mortar'],             array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p4',  'Building Sand',             'Aggregates',          'bag',    4.50,  array['sand','aggregate','ballast'],             array['b1','b3','b5','b7','b9','b11']),
  ('p5',  'Plasterboard',              'Building Materials',  'sheet',  9.20,  array['plasterboard','drywall','gypsum'],        array['b1','b2','b4','b6','b10']),
  ('p6',  'Loft Insulation Roll',      'Insulation',          'roll',   22.00, array['insulation','loft','mineral wool'],       array['b2','b4','b6','b8','b10','b12']),
  ('p7',  'OSB3 Board',                'Timber',              'sheet',  14.50, array['osb','board','sheathing','wood'],         array['b1','b3','b5','b7','b9']),
  ('p8',  'Wood Screws',               'Fixings & Fasteners', 'box',    5.30,  array['screws','fixings','fasteners'],           array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p9',  'Concrete Blocks',           'Building Materials',  'each',   1.35,  array['block','concrete block','blockwork'],     array['b1','b2','b3','b4','b5']),
  ('p10', 'Concrete Roof Tiles',       'Roofing',             'each',   1.10,  array['roof','tile','roofing'],                  array['b3','b5','b7','b9','b11']),
  ('p11', 'Hi-Vis Safety Vest',        'PPE',                 'each',   3.25,  array['hi-vis','vest','ppe','safety'],           array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p12', 'Safety Helmet',             'PPE',                 'each',   7.80,  array['helmet','hard hat','ppe','safety'],       array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p13', 'Copper Pipe',               'Plumbing',            'length', 11.40, array['pipe','copper','plumbing'],               array['b2','b4','b6','b8','b10']),
  ('p14', 'Cordless Combi Drill',      'Tools',               'each',   89.00, array['drill','tool','cordless','power tool'],   array['b1','b3','b5','b7','b9','b11']),
  ('p15', 'PVC Waste Pipe',            'Plumbing',            'length', 8.90,  array['pipe','pvc','waste','drainage'],          array['b1','b2','b3','b4','b5','b6']),
  ('p16', 'MDF Board',                 'Timber',              'sheet',  13.20, array['mdf','board','wood'],                     array['b2','b4','b6','b8']);

insert into product_variants (product_id, label, sort_order) values
  ((select id from products where catalogue_key = 'p1'), '75x75mm x 2.4m',   0),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 1.8m', 1),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 2.4m', 2),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 3.0m', 3),

  ((select id from products where catalogue_key = 'p2'), '8mm x 6m',  0),
  ((select id from products where catalogue_key = 'p2'), '10mm x 6m', 1),
  ((select id from products where catalogue_key = 'p2'), '12mm x 6m', 2),
  ((select id from products where catalogue_key = 'p2'), '10mm x 12m', 3),

  ((select id from products where catalogue_key = 'p3'), '10kg bag', 0),
  ((select id from products where catalogue_key = 'p3'), '25kg bag', 1),

  ((select id from products where catalogue_key = 'p4'), '25kg bag', 0),
  ((select id from products where catalogue_key = 'p4'), 'Bulk bag (~800kg)', 1),

  ((select id from products where catalogue_key = 'p5'), '2400x1200x9.5mm',  0),
  ((select id from products where catalogue_key = 'p5'), '2400x1200x12.5mm', 1),
  ((select id from products where catalogue_key = 'p5'), '3000x1200x12.5mm', 2),

  ((select id from products where catalogue_key = 'p6'), '100mm', 0),
  ((select id from products where catalogue_key = 'p6'), '150mm', 1),
  ((select id from products where catalogue_key = 'p6'), '200mm', 2),

  ((select id from products where catalogue_key = 'p7'), '9mm 2440x1220mm',  0),
  ((select id from products where catalogue_key = 'p7'), '11mm 2440x1220mm', 1),
  ((select id from products where catalogue_key = 'p7'), '18mm 2440x1220mm', 2),

  ((select id from products where catalogue_key = 'p8'), '4x40mm (Box of 200)',  0),
  ((select id from products where catalogue_key = 'p8'), '5x100mm (Box of 100)', 1),
  ((select id from products where catalogue_key = 'p8'), '6x120mm (Box of 50)',  2),

  ((select id from products where catalogue_key = 'p9'), '7N 440x215x100mm', 0),
  ((select id from products where catalogue_key = 'p9'), '7N 440x215x140mm', 1),
  ((select id from products where catalogue_key = 'p9'), '10N 440x215x100mm', 2),

  ((select id from products where catalogue_key = 'p10'), 'Interlocking - Slate Grey', 0),
  ((select id from products where catalogue_key = 'p10'), 'Interlocking - Terracotta', 1),
  ((select id from products where catalogue_key = 'p10'), 'Plain Tile - Red', 2),

  ((select id from products where catalogue_key = 'p11'), 'S', 0),
  ((select id from products where catalogue_key = 'p11'), 'M', 1),
  ((select id from products where catalogue_key = 'p11'), 'L', 2),
  ((select id from products where catalogue_key = 'p11'), 'XL', 3),

  ((select id from products where catalogue_key = 'p12'), 'White', 0),
  ((select id from products where catalogue_key = 'p12'), 'Yellow', 1),
  ((select id from products where catalogue_key = 'p12'), 'Orange', 2),
  ((select id from products where catalogue_key = 'p12'), 'Blue', 3),

  ((select id from products where catalogue_key = 'p13'), '15mm x 3m', 0),
  ((select id from products where catalogue_key = 'p13'), '22mm x 3m', 1),
  ((select id from products where catalogue_key = 'p13'), '28mm x 3m', 2),

  ((select id from products where catalogue_key = 'p14'), '18V - Body Only', 0),
  ((select id from products where catalogue_key = 'p14'), '18V - 1 Battery Kit', 1),
  ((select id from products where catalogue_key = 'p14'), '18V - 2 Battery Kit', 2),

  ((select id from products where catalogue_key = 'p15'), '32mm x 3m',  0),
  ((select id from products where catalogue_key = 'p15'), '40mm x 3m',  1),
  ((select id from products where catalogue_key = 'p15'), '110mm x 3m', 2),

  ((select id from products where catalogue_key = 'p16'), '12mm 2440x1220mm', 0),
  ((select id from products where catalogue_key = 'p16'), '18mm 2440x1220mm', 1),
  ((select id from products where catalogue_key = 'p16'), '25mm 2440x1220mm', 2);
