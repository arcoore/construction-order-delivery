-- Phase B hardening — closes a real gap found during the Phase B final
-- audit: `supplier_branches_select_active` (0017) only ever checked the
-- BRANCH's own `active` flag — deactivating a supplier had zero effect on
-- whether its branches were still offered for new orders, since nothing
-- checked the parent `suppliers.active` at all. Confirmed empirically in a
-- rolled-back transaction: deactivating "Travis Perkins" left b1/b5/b11
-- fully selectable by an authenticated read.
--
-- 0017 is already applied to hosted `sitestock-dev` and is never edited —
-- this is a new, narrow, forward-only migration that replaces exactly one
-- RLS policy. No table is redesigned, no seed row is touched, no catalogue
-- key changes, no supplier/branch UUID changes, no order schema/RPC change,
-- no new write grant, no Realtime, no admin tooling. `suppliers` itself was
-- already correctly active-only (`suppliers_select_active`, unchanged here)
-- — this migration only widens what `supplier_branches`' own policy checks.

drop policy supplier_branches_select_active on supplier_branches;

-- New visibility rule for authenticated reads: a branch is only visible if
-- BOTH it and its parent supplier are active. The subquery's own result is
-- already implicitly filtered by suppliers_select_active (RLS applies to
-- every read of that table, including from inside another policy's USING
-- clause) — the explicit `s.active = true` here is kept anyway for
-- defense-in-depth and readability, so this policy's own intent is clear
-- without needing to trace through a second policy to verify it.
create policy supplier_branches_select_active on supplier_branches
  for select to authenticated using (
    active = true
    and exists (
      select 1 from suppliers s
      where s.id = supplier_branches.supplier_id
        and s.active = true
    )
  );

-- Historical order display is deliberately UNAFFECTED by this change — see
-- CLAUDE.md's Phase B section. orders.stockist_name/stockist_website/
-- stockist_postcode are point-in-time snapshots, never a live join to this
-- table, so a supplier/branch later going inactive never alters how a past
-- order reads. The one real frontend consequence is driver.js's live
-- getBranch(order.stockistId) pickup-coordinate lookup, which can now
-- legitimately resolve to null for an in-flight order referencing a
-- newly-inactive branch — handled by a separate, frontend-only fix in this
-- same hardening pass (public/js/driver.js), not by this migration.
