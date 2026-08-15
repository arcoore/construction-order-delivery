-- Cancellation requests are their own record, deliberately never mutating
-- the order into a fake intermediate status while pending — order.status is
-- left completely untouched by a pending request, exactly matching the
-- prototype's Phase 7B design (a Driver can still claim/collect normally
-- while a request sits pending; the request is what resolves, not the
-- order's own status).

create table cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  community_id uuid not null references communities (id),
  site_id uuid not null,
  foreign key (site_id, community_id) references sites (id, community_id),
  requested_by_id uuid not null references profiles (id),
  requested_by text not null,
  reason text,
  status cancellation_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_id uuid references profiles (id),
  decided_by text,
  decision_reason text
);

-- Enforces "only one pending request per order" as a real database
-- constraint rather than an application-level convention.
create unique index one_pending_cancellation_per_order
  on cancellation_requests (order_id)
  where status = 'pending';

create index cancellation_requests_order_idx on cancellation_requests (order_id);
create index cancellation_requests_community_status_idx
  on cancellation_requests (community_id, status);
