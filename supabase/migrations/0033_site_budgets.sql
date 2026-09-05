-- Site monthly budgets with a hard block (product-audit gap fix).
--
-- A site can carry an optional monthly_budget. "Committed spend" for a site
-- in the current calendar month = the sum of total_price over that site's
-- orders that aren't rejected/cancelled, created this month. An order whose
-- total would push committed spend over the budget cannot be created, and an
-- edit that would push it over is refused — the owner must raise the budget
-- (or wait for the month to roll) first. Even the owner is blocked: the
-- budget is the control, raising it is the deliberate act.
--
-- Enforced by a BEFORE INSERT OR UPDATE trigger on orders rather than by
-- editing create_order / edit_order / approve_order / start_purchase
-- individually: it's a single cross-cutting invariant, it can't be bypassed
-- by a future RPC, and it lives in one place. The trigger only runs its
-- check when total_price or site_id actually changes (a plain status
-- transition — approve, purchase, deliver — passes straight through), so an
-- order that was already within budget can never be retroactively blocked
-- from completing just because the owner later lowered the cap.

alter table sites
  add column monthly_budget numeric check (monthly_budget is null or monthly_budget >= 0);

-- Current-month committed spend for a site, optionally excluding one order
-- (so an edit re-check doesn't count the order against itself).
create or replace function _site_committed_spend(p_site_id uuid, p_exclude_order_id uuid default null)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(total_price), 0)
  from orders
  where site_id = p_site_id
    and (p_exclude_order_id is null or id <> p_exclude_order_id)
    and status not in ('rejected', 'cancelled')
    and date_trunc('month', created_at) = date_trunc('month', now());
$$;

create or replace function _enforce_site_budget()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_budget numeric;
  v_committed numeric;
begin
  -- A rejected/cancelled order never counts, so nothing to check.
  if new.status in ('rejected', 'cancelled') then
    return new;
  end if;

  -- Only a genuine money/site change is checked; a pure status transition
  -- on an already-accepted order is exempt.
  if tg_op = 'UPDATE'
     and new.total_price is not distinct from old.total_price
     and new.site_id is not distinct from old.site_id then
    return new;
  end if;

  -- FOR UPDATE serializes concurrent order writes for the same site on the
  -- sites row, so two orders that individually fit but together exceed the
  -- budget can't both pass a stale committed-spend read (a real TOCTOU
  -- without this lock). sites rows are almost never updated, so the
  -- contention is negligible.
  select monthly_budget into v_budget from sites where id = new.site_id for update;
  if v_budget is null then
    return new;
  end if;

  -- On INSERT the NEW row isn't in `orders` yet, so the exclude is a no-op;
  -- on UPDATE it stops the order counting against itself.
  v_committed := _site_committed_spend(new.site_id, new.id);

  if v_committed + coalesce(new.total_price, 0) > v_budget then
    raise exception 'This site is at its % monthly budget (already committed: %). Ask the owner to raise it.',
      _format_price(v_budget), _format_price(v_committed)
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger orders_enforce_site_budget
  before insert or update on orders
  for each row execute function _enforce_site_budget();
