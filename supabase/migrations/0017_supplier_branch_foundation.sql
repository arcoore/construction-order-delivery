-- Phase B — supplier + supplier-branch data foundation. Moves the supplier/
-- branch fixture data that used to live exclusively in public/js/data.js's
-- hardcoded `BRANCHES` array into real Postgres tables, as GLOBAL SiteStock
-- reference data (not scoped to any community — real builders' merchants
-- are the same physical businesses regardless of which SiteStock community
-- is ordering from them). This is the DATA FOUNDATION only — see
-- CLAUDE.md's Phase B section before assuming anything about price, stock,
-- or live merchant integration: none of that exists yet, and none of it is
-- introduced here.
--
-- IMPORTANT — THIS IS MIGRATED FIXTURE/DEMO DATA, NOT MERCHANT-VERIFIED
-- DATA. Every row seeded below is the exact same demo data that was
-- previously hardcoded in data.js's `BRANCHES` array (name, website,
-- postcode, and an approximate city-centre lat/lon — see that file's own
-- header comment, unchanged: "Coordinates are approximate city-centre
-- locations for demo purposes, not exact street addresses"). Moving it into
-- Supabase for structural reasons (a real table beats a hardcoded array
-- once more than one module needs to query/reference it) does NOT mean any
-- of it became live, official, current, or merchant-sourced. No merchant
-- API, affiliate feed, or EDI integration was contacted to produce or
-- verify any of this.
--
-- CATALOGUE-KEY COMPATIBILITY — supplier_branches.catalogue_key holds the
-- exact same stable string identifiers ('b1'..'b12') that
-- PRODUCTS[].branchIds (public/js/data.js, unchanged by this migration) and
-- every existing order's stockist_id column already use. The new
-- supplier_branches.id UUID is purely this table's own internal primary
-- key — nothing outside public/js/suppliers.js ever sees or stores it.
-- This means: zero changes to data.js's PRODUCTS fixture, zero changes to
-- the orders table or its RPCs, and every historical order's stockist_id
-- (already a plain `text` column — see 0005_orders_and_events.sql) keeps
-- resolving correctly against catalogue_key, whether that order was placed
-- before or after this migration.

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

-- name here is the branch's LOCATION only (e.g. "London Wandsworth"), not
-- the combined "Travis Perkins - London Wandsworth" string data.js used to
-- store as one field — public/js/suppliers.js reconstructs that exact
-- combined display string client-side from suppliers.name + this column,
-- so every existing render call site (site.js, driver.js) sees an
-- identically-shaped string to before, unchanged.
create table supplier_branches (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers (id) on delete restrict,
  catalogue_key text not null unique,
  name text not null,
  postcode text not null,
  latitude double precision,
  longitude double precision,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, postcode),
  -- Basic geographic validity only (not a UK-only bounding box) — the
  -- application may expand beyond the UK eventually, and encoding "SiteStock
  -- can only ever have UK branches" into the database would be a real
  -- future migration to undo for no present benefit. Postcode normalization
  -- (UK-specific) stays an application-layer concern in geo.js/suppliers.js.
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

create index supplier_branches_supplier_idx on supplier_branches (supplier_id);
create index supplier_branches_coords_idx on supplier_branches (latitude, longitude);

-- ---------------------------------------------------------------- RLS
-- Global reference data — no community or user owns a row here, so unlike
-- every other table in this schema, no auth.uid()-scoped ownership check
-- applies. authenticated users get read-only access to ACTIVE rows only,
-- enforced at the RLS layer itself (not just a client-side filter) — an
-- inactive supplier/branch is invisible to a normal SELECT regardless of
-- what query the client sends. No INSERT/UPDATE/DELETE policy exists for
-- `authenticated` at all, and none is granted below — matching the
-- notifications table's precedent exactly (CLAUDE.md: "no INSERT grant for
-- authenticated at all"). Being a community Owner grants zero extra
-- permission over this data; it isn't community-scoped, so no
-- Owner-privilege concept applies here. The only writer for Phase B is this
-- migration's own seed, below. A future maintenance path (if ever needed)
-- would be a SECURITY DEFINER admin RPC or a direct, service-role-scoped
-- edit outside the browser — never a generic write grant to authenticated,
-- and never a service_role key shipped to the browser (see
-- supabase/README.md's "Security notes" section).

alter table suppliers enable row level security;
alter table supplier_branches enable row level security;

grant select on suppliers to authenticated;
grant select on supplier_branches to authenticated;
-- no grant to anon at all — matches this schema's default-deny for
-- unauthenticated access (see 0009_rls_policies.sql's header); anon gets no
-- base table privilege here, so a query fails at the grant check before RLS
-- is even evaluated.

create policy suppliers_select_active on suppliers
  for select to authenticated using (active = true);

create policy supplier_branches_select_active on supplier_branches
  for select to authenticated using (active = true);

-- no insert/update/delete policy on either table for any role — intentional.

-- ---------------------------------------------------------------- seed
-- Six supplier brands, twelve branches — the exact fixture set that lived
-- in data.js's BRANCHES array immediately before this migration. Do not add
-- merchants not already represented there, and do not "improve" any
-- coordinate/postcode without a real, separately-stated reason — this is a
-- like-for-like structural move, not a data refresh.

insert into suppliers (name, website) values
  ('Travis Perkins', 'travisperkins.co.uk'),
  ('Jewson', 'jewson.co.uk'),
  ('Selco', 'selcobw.com'),
  ('Wickes Trade', 'wickes.co.uk'),
  ('MKM Building Supplies', 'mkmbs.co.uk'),
  ('Buildbase', 'buildbase.co.uk');

insert into supplier_branches (supplier_id, catalogue_key, name, postcode, latitude, longitude) values
  ((select id from suppliers where name = 'Travis Perkins'),        'b1',  'London Wandsworth', 'SW18 4ES', 51.4571, -0.1998),
  ((select id from suppliers where name = 'Jewson'),                'b2',  'Manchester',        'M11 4AU',  53.4808, -2.1749),
  ((select id from suppliers where name = 'Selco'),                 'b3',  'Birmingham',        'B6 7DB',   52.4862, -1.8904),
  ((select id from suppliers where name = 'Wickes Trade'),          'b4',  'Leeds',             'LS10 1AB', 53.8008, -1.5491),
  ((select id from suppliers where name = 'Travis Perkins'),        'b5',  'Bristol',           'BS1 6XX',  51.4545, -2.5879),
  ((select id from suppliers where name = 'Jewson'),                'b6',  'Glasgow',           'G1 1AA',   55.8642, -4.2518),
  ((select id from suppliers where name = 'MKM Building Supplies'), 'b7',  'Liverpool',         'L1 8JQ',   53.4084, -2.9916),
  ((select id from suppliers where name = 'Selco'),                 'b8',  'Newcastle',         'NE1 7RU',  54.9783, -1.6178),
  ((select id from suppliers where name = 'Buildbase'),             'b9',  'Sheffield',         'S1 2HE',   53.3811, -1.4701),
  ((select id from suppliers where name = 'Jewson'),                'b10', 'Nottingham',        'NG1 6HA',  52.9548, -1.1581),
  ((select id from suppliers where name = 'Travis Perkins'),        'b11', 'Cardiff',           'CF10 1EP', 51.4816, -3.1791),
  ((select id from suppliers where name = 'Buildbase'),             'b12', 'Edinburgh',         'EH1 1AA',  55.9533, -3.1883);
