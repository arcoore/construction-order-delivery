-- Companies (kept as "communities" internally per explicit direction — the
-- product surfaces "Company" language to users, but this migration does not
-- perform a rename to avoid unnecessary churn).

create table communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  owner_id uuid not null references profiles (id),
  require_owner_approval boolean not null default true,
  created_at timestamptz not null default now()
);

-- Unifies the prototype's two concepts (join_requests + "approved member"
-- derived from a join_requests row) into one table with a status.
create table community_memberships (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id) on delete cascade,
  user_id uuid not null references profiles (id),
  status membership_status not null default 'pending',
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_id uuid references profiles (id),
  unique (community_id, user_id)
);

create index community_memberships_community_status_idx
  on community_memberships (community_id, status);
create index community_memberships_user_idx on community_memberships (user_id);

-- Owner-level access, additive to the fixed community.owner_id creator.
create table owner_grants (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id) on delete cascade,
  user_id uuid not null references profiles (id),
  granted_by_id uuid not null references profiles (id),
  granted_at timestamptz not null default now(),
  unique (community_id, user_id)
);

-- Buyer access — owner-granted only, never automatic (mirrors the
-- prototype's deliberate "not bundled free like worker/driver" rule).
create table buyer_grants (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id) on delete cascade,
  user_id uuid not null references profiles (id),
  granted_by_id uuid not null references profiles (id),
  granted_at timestamptz not null default now(),
  unique (community_id, user_id)
);

create table buyer_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities (id) on delete cascade,
  user_id uuid not null references profiles (id),
  status membership_status not null default 'pending',
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_id uuid references profiles (id),
  unique (community_id, user_id)
);

create index owner_grants_community_idx on owner_grants (community_id);
create index buyer_grants_community_idx on buyer_grants (community_id);
create index buyer_requests_community_status_idx on buyer_requests (community_id, status);
