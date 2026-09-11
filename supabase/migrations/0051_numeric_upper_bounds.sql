-- Upper bounds on user-entered numeric fields that only ever had a lower
-- bound (quantity > 0, price >= 0, ...) — a deeper pass following the
-- 2026-09-11 security audit. Not a money-at-risk bug (SiteStock never
-- processes a real payment; a Buyer always pays externally and just
-- confirms), but a genuinely unbounded numeric input is still worth
-- closing on general principle: it lets a malformed or malicious client
-- write a nonsensical value that then corrupts the owner's dashboard
-- totals/budget math and any future export/reporting built on this data.
-- Ceilings below are deliberately absurd relative to any real construction
-- order/company — this closes the "no upper bound at all" gap without
-- constraining any real, legitimate use.

alter table order_items
  add constraint order_items_quantity_upper_bound check (quantity <= 1000000),
  add constraint order_items_unit_price_upper_bound check (unit_price is null or unit_price <= 10000000);

alter table sites
  add constraint sites_monthly_budget_upper_bound check (monthly_budget is null or monthly_budget <= 100000000);

alter table communities
  add constraint communities_approval_threshold_upper_bound check (approval_threshold is null or approval_threshold <= 100000000);
