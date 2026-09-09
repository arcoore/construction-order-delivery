-- Flood guard + retention for client_errors (migration 0047): the one
-- anon-writable endpoint gets a global per-minute insert cap and a prune.
begin;
select plan(9);

-- ---- flood guard ------------------------------------------------------
select lives_ok(
  $$ insert into client_errors (kind, message) values ('error', 'a legit report') $$,
  'item 1: a normal single insert is accepted');

-- fill the 60-second window to the 500 ceiling
insert into client_errors (kind, message)
select 'error', 'fill ' || g from generate_series(1, 499) g;
select is((select count(*)::int from client_errors), 500, 'item 2: 500 rows now sit in the window');

select throws_ok(
  $$ insert into client_errors (kind, message) values ('error', 'one over the line') $$,
  '53400', 'client_errors: too many reports, throttled',
  'item 3: the 501st insert inside the window is refused');

select throws_ok(
  $$ insert into client_errors (kind, message)
     select 'error', 'bulk ' || g from generate_series(1, 50) g $$,
  '53400', null,
  'item 4: a bulk insert that would cross the line is refused too');

-- age everything past the window; inserts recover (rolling window, not a lock)
update client_errors set created_at = created_at - interval '61 seconds';
select lives_ok(
  $$ insert into client_errors (kind, message) values ('error', 'after the window') $$,
  'item 5: once the 60s window rolls past, inserts are accepted again');

-- ---- prune -----------------------------------------------------------
insert into client_errors (kind, message, created_at)
  values ('error', 'ancient', now() - interval '45 days');
select is(prune_client_errors(), 1, 'item 6: prune removes the one >30-day-old row');
select is((select count(*)::int from client_errors where created_at < now() - interval '30 days'),
  0, 'item 7: nothing older than 30 days survives the prune');

-- ---- grants ---------------------------------------------------------
select throws_ok(
  format($$ set role authenticated; select prune_client_errors() $$),
  '42501', null,
  'item 8: an authenticated caller cannot run prune_client_errors');
reset role;
select throws_ok(
  format($$ set role anon; select prune_client_errors() $$),
  '42501', null,
  'item 9: an anon caller cannot run prune_client_errors');
reset role;

select finish();
rollback;
