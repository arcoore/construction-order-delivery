-- Site contacts + expanded status (product-audit gap fixes).
--
-- Contacts: three additive nullable columns for the person to reach about a
-- site — display-only, never used in any permission or lifecycle decision,
-- same as project_start_date/project_end_date (migration 0025).
--
-- Status: the site_status enum ('active','archived') gains 'paused' and
-- 'completed'. Per the enum-value-in-transaction gotcha documented in
-- migration 0023's header (you cannot ALTER TYPE ... ADD VALUE and then use
-- that value in the same transaction), this converts the column from the
-- enum to a plain text + CHECK constraint — exactly what 0023 did to
-- community_memberships.status for the same reason. The site_status enum
-- type itself is left in place, unused, rather than dropped (an unused type
-- is harmless; dropping DB objects without being asked isn't done here).
--
-- Semantics: 'active' is the only status that accepts NEW orders — 'paused'
-- and 'completed' both behave like 'archived' for ordering (a finished or
-- on-hold project shouldn't get new material requests), they're just shown
-- and managed differently. No existing order's lifecycle is affected by a
-- status change, exactly as archiving already never touches in-flight
-- orders.

alter table sites
  add column site_contact_name text,
  add column site_contact_phone text,
  add column access_notes text;

alter table sites alter column status drop default;
alter table sites alter column status type text using status::text;
alter table sites alter column status set default 'active';
alter table sites add constraint sites_status_check
  check (status in ('active', 'paused', 'completed', 'archived'));
