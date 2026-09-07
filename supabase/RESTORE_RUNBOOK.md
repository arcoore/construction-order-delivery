# Database backup & restore runbook

Operational procedure for backing up the SiteStock Postgres database and
restoring it. Written for the beta; keep it current as the hosting setup
changes.

---

## Why this exists

**The Supabase free tier takes no automatic backups.** If the hosted
`sitestock-dev` database is lost, corrupted, or a bad migration/`DELETE`
wipes real data, there is nothing to roll back to unless *you* have taken a
manual dump. This runbook is that safety net until the project is on a paid
plan (see "When you upgrade" below).

Until then: **take a manual dump before every hosted migration, and on a
regular schedule** (weekly at minimum once there are real users; daily is
better and takes seconds).

---

## 1. Take a backup (manual dump)

Both commands write a compressed custom-format dump (`-Fc`) that
`pg_restore` can read selectively.

### Local stack

```bash
# from the repo root, with the local stack running
MSYS_NO_PATHCONV=1 docker exec supabase_db_sitestock \
  pg_dump -U postgres -d postgres -Fc -f /tmp/sitestock.dump
docker cp supabase_db_sitestock:/tmp/sitestock.dump \
  "./backups/sitestock-local-$(date +%Y%m%d-%H%M).dump"
```

### Hosted (`sitestock-dev`)

Get the connection string from the Supabase dashboard
(Project Settings → Database → Connection string → URI, "session" mode) or
use the CLI. Then:

```bash
# needs a local postgres client (pg_dump) OR run it through the CLI's bundled one
supabase db dump --linked -f "./backups/sitestock-hosted-$(date +%Y%m%d-%H%M).sql"
```

`supabase db dump --linked` writes a plain-SQL dump of the **public schema
data + roles** by default. For a full dump including `auth` (the user
accounts), pass `--data-only=false` and note it does **not** include
`auth.users` rows unless you add `-s auth` / use `pg_dump` directly against
the connection string:

```bash
pg_dump "postgresql://postgres:[PASSWORD]@db.jntbbrkiygbobknzivpe.supabase.co:5432/postgres" \
  -Fc -f "./backups/sitestock-hosted-full-$(date +%Y%m%d-%H%M).dump"
```

Store dumps **outside the repo** (they contain real user data — `./backups/`
is git-ignored; keep a copy somewhere off-machine too).

---

## 2. Restore

### Rehearse first (safe — touches nothing real)

Restore into a throwaway database on the local stack and check the row
counts, exactly as rehearsed on 2026-09-07 (see the record below):

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_sitestock \
  psql -U postgres -d postgres -c "drop database if exists restore_test;" \
                                 -c "create database restore_test;"

MSYS_NO_PATHCONV=1 docker exec supabase_db_sitestock \
  pg_restore -U postgres -d restore_test --no-owner --no-privileges /tmp/sitestock.dump

# verify — counts must match the source
MSYS_NO_PATHCONV=1 docker exec supabase_db_sitestock psql -U postgres -d restore_test -c "
  select 'users' t, count(*) from auth.users
  union all select 'communities', count(*) from communities
  union all select 'orders', count(*) from orders
  union all select 'sites', count(*) from sites;"

MSYS_NO_PATHCONV=1 docker exec supabase_db_sitestock \
  psql -U postgres -d postgres -c "drop database restore_test;"
```

**Expected noise:** `pg_restore` prints a handful of ignored errors
(`cron.*`, `supabase_admin` grants, extension owners) when restoring outside
a real Supabase project. Those objects are provided by the platform, not the
dump — the *data* still restores correctly. On a real Supabase target they
don't appear.

### Restore for real (hosted disaster recovery)

1. **Stop writes.** Flip the kill switch so nothing new is written while you
   work:
   ```sql
   update public.app_status set killed = true,
     message = 'Restoring data — back shortly.', updated_at = now() where id = 1;
   ```
2. Decide scope: full DB restore (new project) vs. restoring specific tables
   into the existing one. For a bad `DELETE`/migration, table-level is
   usually right:
   ```bash
   pg_restore --data-only --table=orders --table=order_items \
     -d "postgresql://postgres:[PASSWORD]@db.jntbbrkiygbobknzivpe.supabase.co:5432/postgres" \
     ./backups/sitestock-hosted-full-YYYYMMDD-HHMM.dump
   ```
   (Restoring data into a table that still has rows will conflict on primary
   keys — `truncate` the target first, or restore into a temp table and
   `INSERT ... ON CONFLICT` the rows you need.)
3. Re-run any migrations that were applied *after* the dump was taken.
4. Verify: row counts, a spot-check of a known record, and a real login +
   order-lifecycle walkthrough.
5. Clear the kill switch:
   ```sql
   update public.app_status set killed = false, updated_at = now() where id = 1;
   ```

---

## 3. Rehearsal record

| Date | Environment | Result |
|------|-------------|--------|
| 2026-09-07 | Local stack, full `pg_dump -Fc` (700 KB) → `pg_restore` into a fresh `restore_test` DB | **PASS.** All 7 checked tables' row counts matched the source (users 5, communities 1, community_memberships 4, sites 2, orders 3, profiles 5, app_status 1); `communities` spot-check (`Redbridge Construction` / `RDBRDG`) intact. 8 ignored `pg_restore` errors, all platform-object noise as expected. Scratch DB + dump torn down after. |

Re-run this rehearsal after any migration that changes table structure, and
at least once before the first real beta user.

---

## When you upgrade (Supabase Pro, ~$25/mo)

Pro adds, with no extra work:

- **Daily automatic backups**, retained 7 days.
- **Point-in-time recovery (PITR)** — restore to any second, not just the
  last daily snapshot. (PITR is a further paid add-on on top of Pro.)

Once on Pro, the manual dumps in section 1 become a belt-and-braces extra
(still worth doing before a big migration) rather than the only safety net.
This runbook's restore steps still apply — Pro just gives you a much better
starting point to restore *from*.
