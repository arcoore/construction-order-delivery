-- Sites: job locations inside a company. Archiving, never hard deletion —
-- matches the prototype's explicit "no permanent-delete function exists"
-- rule; a foreign key from orders/cancellation_requests to sites would make
-- hard deletion of a referenced site impossible anyway.

create table sites (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id) on delete cascade,
  name text not null,
  address text,
  postcode text,
  delivery_instructions text,
  status site_status not null default 'active',
  created_by_id uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_by_id uuid references profiles (id),
  archived_at timestamptz,

  -- Lets any table with a (site_id, community_id) pair declare a composite
  -- foreign key against this, so "does this site really belong to this
  -- community" becomes a database-enforced invariant instead of the
  -- prototype's manual siteBelongsToCommunity() runtime re-check — the
  -- exact real bug class Phase 4A caught and fixed by hand.
  unique (id, community_id)
);

create index sites_community_status_idx on sites (community_id, status);

-- Many-to-many: a site can have any number of members, a user can belong to
-- any number of sites. community_id is denormalized here on purpose (same
-- defense-in-depth reasoning as the prototype), and the composite foreign
-- key below makes it impossible for this row to ever point at a site that
-- actually belongs to a different community than the one recorded here.
create table site_memberships (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null,
  community_id uuid not null,
  user_id uuid not null references profiles (id),
  added_by_id uuid not null references profiles (id),
  added_at timestamptz not null default now(),
  unique (site_id, user_id),
  foreign key (site_id, community_id) references sites (id, community_id) on delete cascade
);

create index site_memberships_site_idx on site_memberships (site_id);
create index site_memberships_user_idx on site_memberships (user_id);
