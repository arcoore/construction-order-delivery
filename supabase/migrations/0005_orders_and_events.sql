-- Orders: the core work-product. Every actor field carries BOTH a real
-- foreign key (referential integrity, joins, permission checks) AND a
-- redundant plain-text snapshot column (the display name at the moment of
-- the action). This is deliberate duplication, not sloppy normalization —
-- it preserves the prototype's explicit, tested principle that renaming a
-- user or a site later must never rewrite how a historical order reads.
--
-- version supports optimistic concurrency for payload edits that aren't a
-- status transition (see 0010) — status-transition races are instead
-- resolved by conditional UPDATE ... WHERE status = $expected, which
-- Postgres's row-level atomicity already resolves for free.

create table orders (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id),
  site_id uuid not null,
  foreign key (site_id, community_id) references sites (id, community_id),

  -- Site snapshot, frozen at creation — never re-derived from a live join.
  site_name text not null,
  site_address text,
  site_postcode text,
  site_delivery_instructions text,

  -- Catalog reference. The mock catalog is still static frontend data with
  -- no database table of its own, so these stay plain identifiers/snapshots
  -- rather than real foreign keys — an intentional, temporary gap, not an
  -- oversight (flagged again in the architecture doc).
  product_id text not null,
  product_name text not null,
  variant text,
  quantity numeric not null check (quantity > 0),
  unit text not null,

  delivery_postcode text not null,
  delivery_lat double precision,
  delivery_lon double precision,

  requested_by_id uuid not null references profiles (id),
  requested_by text not null,

  status order_status not null default 'pending_approval',
  approval_was_required boolean not null default true,
  created_at timestamptz not null default now(),

  driver_id uuid references profiles (id),
  driver text,
  claimed_at timestamptz,
  collected_at timestamptz,
  delivered_at timestamptz,
  delivery_time timestamptz,
  delivery_location text,

  stockist_id text,
  stockist_name text,
  stockist_website text,
  stockist_postcode text,
  pickup_estimate text,

  unit_price numeric,
  total_price numeric,

  approved_by_id uuid references profiles (id),
  approved_by text,
  approved_at timestamptz,

  rejected_by_id uuid references profiles (id),
  rejected_by text,
  rejected_at timestamptz,
  rejection_reason text,

  purchase_started_by_id uuid references profiles (id),
  purchase_started_by text,
  purchase_started_at timestamptz,

  purchased_by_id uuid references profiles (id),
  purchased_by text,
  purchased_at timestamptz,

  -- Driver dropping their own claim — order stays alive, returns to pool.
  cancelled_by_id uuid references profiles (id),
  cancelled_by text,
  cancelled_at timestamptz,
  cancellation_reason text,

  -- Terminal cancellation of the order itself (direct or via a decided
  -- cancellation request) — deliberately distinct columns from the pair
  -- above; conflating them would blur an accountability distinction the
  -- prototype already went out of its way to preserve.
  order_cancelled_by_id uuid references profiles (id),
  order_cancelled_by text,
  order_cancelled_at timestamptz,
  order_cancellation_reason text,

  version integer not null default 1
);

create index orders_community_status_idx on orders (community_id, status);
create index orders_site_idx on orders (site_id);
create index orders_requested_by_idx on orders (requested_by_id);
create index orders_driver_idx on orders (driver_id) where driver_id is not null;
create index orders_pool_idx on orders (community_id, status) where status = 'purchased' and driver_id is null;

-- Append-only audit trail. No UPDATE/DELETE policy is ever granted to the
-- authenticated role (0009) — the only way a row is ever created is via the
-- RPC functions in 0010, and no function in this codebase is ever written
-- to modify or remove an existing event, mirroring (and now also
-- database-enforcing, for normal clients) the prototype's "no exported
-- update/delete function is ever exported" convention.
create table order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  community_id uuid not null references communities (id),
  type text not null check (type in (
    'order_created', 'approved', 'rejected', 'approval_reverted',
    'purchase_started', 'purchase_abandoned', 'purchased',
    'delivery_claimed', 'delivery_cancelled', 'delivery_returned_to_pool',
    'collected', 'delivered',
    'order_edited', 'order_cancelled', 'cancellation_requested', 'cancellation_rejected'
  )),
  actor_id uuid references profiles (id),
  actor_name text,
  from_status order_status,
  to_status order_status,
  reason text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index order_events_order_idx on order_events (order_id, created_at);
