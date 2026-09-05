-- Site project dates — additive, nullable columns only, same "no data-
-- bearing bump needed" precedent already used throughout this project
-- (requireOwnerApproval, siteId, needed_by_type/needed_by). A site with no
-- dates set behaves exactly as it always has; nothing reads these two
-- columns as authoritative for anything today except display.
--
-- Deliberately NOT touching site_status: expanding it to more values than
-- active/archived (e.g. paused/completed) would repeat the exact enum-value-
-- in-transaction gotcha migration 0023's header already documents for
-- community_memberships.status, and no concrete product need for those
-- extra values was established this phase — scoped out on purpose, same
-- "don't add enum values speculatively" discipline CLAUDE.md already states.

alter table sites
  add column project_start_date date,
  add column project_end_date date,
  add constraint sites_project_dates_order
    check (project_start_date is null or project_end_date is null or project_end_date >= project_start_date);
