-- Supplier offers + affiliate-ready outbound links (Roadmap Step 1 groundwork,
-- built "as if the affiliate account already exists" - 2026-09-23).
--
-- WHAT THIS IS, HONESTLY
-- ----------------------
-- SiteStock still has NO merchant feed, NO affiliate account, and NO real
-- merchant pricing (see CLAUDE.md's Roadmap Step 1 - blocked on an 18+
-- contracting party for Awin). This migration builds the plumbing so that,
-- the day a real product feed exists, it is a data import - not a redesign:
--
--   * supplier_offers - one row per (supplier, SiteStock product, optional
--     variant): a real merchant price, stock flag and product deep link.
--     Starts EMPTY. This migration seeds no offers and invents no prices or
--     product URLs - anything not backed by a row here keeps being shown as
--     "indicative" (products.unit_price, still demo data) by the client.
--   * suppliers gain the affiliate/search-link columns the link builder needs
--     (public/js/affiliate.js). All default to NULL = "no affiliate network,
--     no verified search URL" -> the app falls back to the merchant homepage,
--     exactly today's behaviour.
--   * order_items remember WHICH offer priced them (offer_id/offer_url/
--     price_source) so the Buyer can be handed the right product link.
--   * affiliate_clicks - a small, append-only, RPC-only log of "a supplier
--     link for this order was opened", for reconciling commission later.
--     Deliberately does NOT record who clicked (see below).
--
-- SERVER-VERIFIED PRICE FOR OFFER-BACKED ITEMS
-- --------------------------------------------
-- unit_price has always been client-asserted (CLAUDE.md "Pricing trust
-- boundary"). For an item that carries an `offerId`, the server now REFUSES
-- the order unless the submitted unitPrice equals the live offer's price and
-- the offer belongs to the order's own supplier - so an offer-backed price
-- cannot be forged. Items without an offerId behave exactly as before.
--
-- This is done in _validate_items (called first thing by create_order and
-- edit_order, both untouched) and _insert_order_items (same signature) - no
-- re-creation of the two big order RPCs, so their state-machine/notification
-- logic cannot regress. Because create_order/edit_order compute total_price
-- from p_items and validation forces an offer-backed unitPrice to equal the
-- offer's, totals stay consistent with the stored rows.

-- ================================================================
-- 1. suppliers - affiliate + search-link config
-- ================================================================
alter table suppliers
  add column affiliate_network text check (affiliate_network is null or affiliate_network in ('awin')),
  -- The merchant's id in that network (Awin's `awinmid`). Not secret.
  add column affiliate_merchant_id text,
  -- e.g. 'https://www.example.com/search?q={query}'. {query} is replaced with
  -- the URL-encoded product name. NULL until a real, checked URL is known -
  -- never guessed. https only (checked below).
  add column search_url_template text
    check (search_url_template is null or (search_url_template ~* '^https://' and search_url_template like '%{query}%')),
  add check (
    (affiliate_network is null and affiliate_merchant_id is null)
    or (affiliate_network is not null and affiliate_merchant_id is not null)
  );

-- ================================================================
-- 2. supplier_offers - real merchant price/stock/link per product
-- ================================================================
create table supplier_offers (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers (id) on delete cascade,
  -- Which curated SiteStock product this offer prices. Feed rows that aren't
  -- mapped onto a catalogue product are not imported (see import_supplier_offers).
  product_key text not null references products (catalogue_key) on delete cascade,
  -- NULL = applies to the product whatever variant was chosen; otherwise the
  -- exact variant label (products/product_variants label string).
  variant_label text,
  -- The merchant's own SKU / product id from the feed. Idempotency key.
  external_id text not null,
  title text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0 and unit_price <= 10000000),
  currency text not null default 'GBP' check (currency = 'GBP'),
  -- NULL = unknown (a feed without stock data).
  in_stock boolean,
  -- Untracked merchant product URL. https only: this value is rendered into
  -- an href, so anything else (javascript:, data:) must be impossible here.
  product_url text check (product_url is null or product_url ~* '^https://[^[:space:]]+$'),
  image_url text check (image_url is null or image_url ~* '^https://[^[:space:]]+$'),
  -- 'feed' = imported from a real merchant feed; 'manual' = a human typed it.
  -- (There is deliberately no 'demo' - demo prices stay in products.unit_price.)
  source text not null default 'feed' check (source in ('feed', 'manual')),
  last_synced_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, external_id)
);

-- One ACTIVE offer per (supplier, product, variant): keeps the client's
-- lookup deterministic. coalesce() so two NULL-variant rows also collide.
create unique index supplier_offers_one_active_per_mapping
  on supplier_offers (supplier_id, product_key, coalesce(variant_label, ''))
  where active;
create index supplier_offers_product_idx on supplier_offers (product_key) where active;

alter table supplier_offers enable row level security;
grant select on supplier_offers to authenticated;
-- Global reference data, same treatment as suppliers/products: any signed-in
-- user may read ACTIVE rows (merchant list prices are not company-private;
-- the Driver "never sees an order's price" rule concerns what a company
-- pays, enforced where driver.js renders orders). No write policy or grant
-- for any client role - rows arrive only via import_supplier_offers below.
create policy supplier_offers_select_active on supplier_offers
  for select to authenticated
  using (
    active = true
    and exists (select 1 from suppliers s where s.id = supplier_offers.supplier_id and s.active)
  );

-- ================================================================
-- 3. order_items - remember which offer priced the line
-- ================================================================
alter table order_items
  add column offer_id uuid references supplier_offers (id) on delete set null,
  -- Snapshot of the untracked merchant URL at order time. The client ignores
  -- it if the live offer's supplier no longer matches the order's supplier.
  add column offer_url text check (offer_url is null or offer_url ~* '^https://[^[:space:]]+$'),
  -- 'client' = unit_price asserted by the browser (all pre-0054 rows);
  -- 'feed'/'manual' = verified against a supplier_offers row at order time.
  add column price_source text not null default 'client' check (price_source in ('client', 'feed', 'manual'));

-- Postgres does not promise that `a and b` short-circuits, so a bare
-- (text)::uuid cast next to a "is it set?" guard can still throw on ''.
-- This returns NULL for anything that isn't a well-formed uuid instead.
create or replace function _safe_uuid(p_text text)
returns uuid language sql immutable set search_path = public as $$
  select case
    when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_text::uuid
  end;
$$;

-- ================================================================
-- 4. _validate_items - now also verifies offer-backed prices
-- ================================================================
-- Same signature as 0030's version (so create_order/edit_order, which PERFORM
-- it, need no change); volatility moves immutable -> stable because it now
-- reads supplier_offers.
create or replace function _validate_items(p_items jsonb)
returns void language plpgsql stable set search_path = public as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order needs at least one item' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) elem
    where coalesce(elem->>'productId', '') = ''
       or coalesce(elem->>'productName', '') = ''
       or coalesce(elem->>'unit', '') = ''
       or (elem->>'quantity') is null
       or (elem->>'quantity')::numeric <= 0
       or ((elem->>'unitPrice') is not null and (elem->>'unitPrice')::numeric < 0)
  ) then
    raise exception 'every item needs a product, a unit, and a quantity greater than zero' using errcode = '22023';
  end if;

  -- Offer-backed items: the offer must exist, be live, and the submitted
  -- price must equal it. A malformed id is refused the same way.
  if exists (
    select 1 from jsonb_array_elements(p_items) elem
    where nullif(elem->>'offerId', '') is not null
      and not exists (
        select 1 from supplier_offers so
        where so.id = _safe_uuid(elem->>'offerId')
          and so.active
          and (elem->>'unitPrice') is not null
          and so.unit_price = (elem->>'unitPrice')::numeric
      )
  ) then
    raise exception 'a supplier price changed - please review the order and try again' using errcode = '22023';
  end if;
end;
$$;

-- ================================================================
-- 5. _insert_order_items - persist offer linkage, enforce supplier match
-- ================================================================
-- Same signature as 0030's. Runs AFTER the order row exists, so the order's
-- own stockist_id is the source of truth for "which supplier is this for".
create or replace function _insert_order_items(p_order_id uuid, p_community_id uuid, p_items jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_supplier uuid;
begin
  select sb.supplier_id into v_supplier
  from orders o
  join supplier_branches sb on sb.catalogue_key = o.stockist_id
  where o.id = p_order_id;

  if exists (
    select 1 from jsonb_array_elements(p_items) elem
    where nullif(elem->>'offerId', '') is not null
      and not exists (
        select 1 from supplier_offers so
        where so.id = _safe_uuid(elem->>'offerId')
          and v_supplier is not null
          and so.supplier_id = v_supplier
      )
  ) then
    raise exception 'that supplier price belongs to a different supplier than this order''s stockist' using errcode = '22023';
  end if;

  insert into order_items (
    order_id, community_id, product_id, product_name, variant, quantity, unit,
    unit_price, line_total, sort_order, offer_id, offer_url, price_source
  )
  select p_order_id, p_community_id,
    elem->>'productId', elem->>'productName', nullif(elem->>'variant', ''),
    (elem->>'quantity')::numeric, elem->>'unit',
    (elem->>'unitPrice')::numeric,
    coalesce((elem->>'unitPrice')::numeric, 0) * (elem->>'quantity')::numeric,
    (ord - 1)::integer,
    so.id, so.product_url, coalesce(so.source, 'client')
  from jsonb_array_elements(p_items) with ordinality as t(elem, ord)
  left join supplier_offers so
    on so.id = _safe_uuid(elem->>'offerId');
end;
$$;

-- ================================================================
-- 6. Changing an order's stockist can strand items priced by the OLD
--    supplier's offers. Clear that linkage whenever the supplier changes.
-- ================================================================
create or replace function _clear_stale_offer_links()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new_supplier uuid;
begin
  select supplier_id into v_new_supplier from supplier_branches where catalogue_key = new.stockist_id;
  update order_items oi
     set offer_id = null, offer_url = null, price_source = 'client'
   where oi.order_id = new.id
     and oi.offer_id is not null
     and (select so.supplier_id from supplier_offers so where so.id = oi.offer_id) is distinct from v_new_supplier;
  return new;
end;
$$;
revoke execute on function _clear_stale_offer_links() from public, anon, authenticated;

create trigger orders_clear_stale_offer_links
  after update of stockist_id on orders
  for each row
  when (old.stockist_id is distinct from new.stockist_id)
  execute function _clear_stale_offer_links();

-- ================================================================
-- 7. import_supplier_offers - the ONLY writer of supplier_offers
-- ================================================================
-- Called by the importer (tools/import_offers.py) with the service-role key -
-- never by a browser. Takes an already-MAPPED batch (each row names the
-- SiteStock product it prices; unmapped feed rows are dropped by the tool and
-- never reach here). Semantics: a full sync of one supplier's FEED offers -
-- rows in the batch are upserted live; feed rows for that supplier that are
-- absent from the batch are deactivated, so a product a merchant stops
-- listing stops being offered. 'manual' offers are never touched.
--
-- p_rows: [{ externalId, productKey, variantLabel?, title, unitPrice,
--            inStock?, productUrl?, imageUrl? }, ...]
create or replace function import_supplier_offers(p_supplier_name text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_supplier uuid;
  v_upserted integer := 0;
  v_deactivated integer := 0;
begin
  select id into v_supplier from suppliers where name = p_supplier_name;
  if v_supplier is null then
    raise exception 'unknown supplier %', p_supplier_name using errcode = '42704';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a json array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'batch too large' using errcode = '22023';
  end if;

  -- One row per (product, variant): keep the cheapest, in-stock preferred, so
  -- the partial unique index below can never be tripped by a feed that lists
  -- several SKUs for the same mapping.
  drop table if exists _batch;
  create temporary table _batch on commit drop as
  select distinct on (product_key, variant_label)
    external_id, product_key, variant_label, title, unit_price, in_stock, product_url, image_url
  from (
    select
      elem->>'externalId' as external_id,
      elem->>'productKey' as product_key,
      nullif(elem->>'variantLabel', '') as variant_label,
      elem->>'title' as title,
      (elem->>'unitPrice')::numeric(12,2) as unit_price,
      case when elem ? 'inStock' and jsonb_typeof(elem->'inStock') = 'boolean' then (elem->>'inStock')::boolean end as in_stock,
      nullif(elem->>'productUrl', '') as product_url,
      nullif(elem->>'imageUrl', '') as image_url
    from jsonb_array_elements(p_rows) elem
  ) r
  order by product_key, variant_label, (in_stock is not true), unit_price, external_id;

  -- Report how many previously-live feed offers this batch dropped...
  select count(*) into v_deactivated
  from supplier_offers so
  where so.supplier_id = v_supplier and so.source = 'feed' and so.active
    and not exists (select 1 from _batch b where b.external_id = so.external_id);

  -- ...then take EVERY live feed offer for this supplier offline and let the
  -- upsert below bring the batch back. Doing it in this order (rather than
  -- deactivating only the dropped ones) means a SKU remapped to a different
  -- product/variant in the same batch can never collide with its own old slot
  -- in the one-active-per-mapping unique index, whatever order rows arrive in.
  update supplier_offers
     set active = false, updated_at = now()
   where supplier_id = v_supplier and source = 'feed' and active;

  insert into supplier_offers (
    supplier_id, product_key, variant_label, external_id, title, unit_price,
    in_stock, product_url, image_url, source, last_synced_at, active, updated_at
  )
  select v_supplier, b.product_key, b.variant_label, b.external_id, b.title, b.unit_price,
         b.in_stock, b.product_url, b.image_url, 'feed', now(), true, now()
  from _batch b
  on conflict (supplier_id, external_id) do update
    set product_key = excluded.product_key,
        variant_label = excluded.variant_label,
        title = excluded.title,
        unit_price = excluded.unit_price,
        in_stock = excluded.in_stock,
        product_url = excluded.product_url,
        image_url = excluded.image_url,
        last_synced_at = now(),
        active = true,
        updated_at = now()
    -- a human-entered ('manual') offer that happens to share an external id is
    -- never overwritten by a feed
    where supplier_offers.source = 'feed';
  get diagnostics v_upserted = row_count;

  return jsonb_build_object('supplier', p_supplier_name, 'upserted', v_upserted, 'deactivated', v_deactivated);
end;
$$;
revoke execute on function import_supplier_offers(text, jsonb) from public, anon, authenticated;
grant execute on function import_supplier_offers(text, jsonb) to service_role;

-- ================================================================
-- 8. affiliate_clicks + log_affiliate_click
-- ================================================================
-- "A supplier link for THIS ORDER was opened." Enough to reconcile a
-- commission report against SiteStock orders (the link's clickref carries the
-- order id). Deliberately does NOT store which user clicked: it isn't needed
-- for reconciliation, and leaving it out means this table holds no personal
-- data of its own, so account deletion (0045) needs no change.
create table affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  community_id uuid not null,
  supplier_id uuid not null references suppliers (id) on delete cascade,
  link_kind text not null check (link_kind in ('deep', 'search', 'home')),
  -- true only when the URL that was opened actually carried an affiliate tag.
  tracked boolean not null default false,
  created_at timestamptz not null default now()
);
create index affiliate_clicks_order_idx on affiliate_clicks (order_id, created_at desc);
alter table affiliate_clicks enable row level security;
-- No grant, no policy for any client role: RPC-write-only, service-role/SQL read.

-- Per-order flood guard - same shape as 0047/0050.
create or replace function _affiliate_clicks_rate_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (
    select count(*) from affiliate_clicks
    where order_id = new.order_id and created_at > now() - interval '60 seconds'
  ) >= 30 then
    raise exception 'affiliate_clicks: too many clicks too quickly' using errcode = '53400';
  end if;
  return new;
end;
$$;
revoke execute on function _affiliate_clicks_rate_guard() from public, anon, authenticated;
create trigger affiliate_clicks_rate_guard
  before insert on affiliate_clicks
  for each row execute function _affiliate_clicks_rate_guard();

create or replace function log_affiliate_click(p_order_id uuid, p_link_kind text, p_tracked boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_supplier uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_order from orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = '42704';
  end if;
  -- Only someone who could actually purchase this order (or own the company)
  -- has a reason to open its supplier link.
  if not (
    is_owner(v_order.community_id, auth.uid())
    or can_purchase_for_site(v_order.site_id, v_order.community_id, auth.uid())
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select sb.supplier_id into v_supplier from supplier_branches sb where sb.catalogue_key = v_order.stockist_id;
  if v_supplier is null then
    raise exception 'this order has no supplier' using errcode = '22023';
  end if;
  insert into affiliate_clicks (order_id, community_id, supplier_id, link_kind, tracked)
  values (v_order.id, v_order.community_id, v_supplier, p_link_kind, coalesce(p_tracked, false));
end;
$$;
revoke execute on function log_affiliate_click(uuid, text, boolean) from public, anon;
grant execute on function log_affiliate_click(uuid, text, boolean) to authenticated;

-- ================================================================
-- 9. Verified merchant search URLs (the "search" rung of the link ladder)
-- ================================================================
-- Checked 2026-09-23 with one plain GET each of <template>?cement: the final
-- URL kept the query string and the page mentioned the search term (Wickes
-- 693x, Jewson 171x). NOT seeded, deliberately, because the same check did not
-- pass: Travis Perkins (no term in the returned page - likely client-rendered
-- or bot-gated), Selco (404), MKM (redirected to a bare /search, dropping the
-- query - the brand appears to have moved to mkm.com), Buildbase (connection
-- failed). Those suppliers keep a NULL template and fall back to their
-- homepage, exactly as before, until someone verifies a working URL.
-- affiliate_network / affiliate_merchant_id stay NULL for every supplier: no
-- affiliate account exists, so no merchant id is known.
update suppliers set search_url_template = 'https://www.wickes.co.uk/search?text={query}' where name = 'Wickes Trade';
update suppliers set search_url_template = 'https://www.jewson.co.uk/search?q={query}'    where name = 'Jewson';

-- ================================================================
-- 10. Retention for affiliate_clicks
-- ================================================================
-- Commission reports are reconciled within weeks of the click; keeping 13
-- months covers a full annual review and a late-payment dispute, and nothing
-- needs it beyond that. The privacy policy states this figure - change both
-- together. Same shape as prune_notifications() (0029) / prune_client_errors()
-- (0047): a maintenance function with no EXECUTE grant, run by pg_cron.
create or replace function prune_affiliate_clicks()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from affiliate_clicks where created_at < now() - interval '400 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke execute on function prune_affiliate_clicks() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('prune-affiliate-clicks', '51 3 * * *', 'select prune_affiliate_clicks();');
