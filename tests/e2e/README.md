# SiteStock frontend smoke tests

The first automated frontend test suite for this project (previously zero -
see the founder's own launch-blockers notes). Python + Playwright + pytest,
deliberately **not** Node/npm - this project has no build step and no Node
install (see CLAUDE.md's "Running it" section), and this suite follows the
same rule `dev_server.py` already set.

## What this covers, and what it deliberately doesn't

Every test here runs against a real `dev_server.py` instance with **no
Supabase backend required** - `conftest.py`'s `console_errors` fixture
filters out the connection-refused noise that produces when no backend is
running, so these tests work identically whether or not Docker/Supabase is
up. That's a deliberate scope choice, not an oversight: it covers exactly
the class of bug that actually shipped undetected on 2026-09-14 (landing
page navigation, dark mode, PWA installability, register-form client-side
validation - all pure client-side rendering/CSS/JS, none of it needing a
live database). A full authenticated order-lifecycle E2E suite (create →
approve → purchase → claim → deliver, per role) would be genuinely valuable
too, but needs a seeded local Supabase stack in the test environment and is
a separate, larger undertaking - not started here.

## Running locally

```bash
pip install -r tests/requirements.txt
python -m playwright install chromium
python -m pytest
```

Runs headless by default. Add `--headed` to watch it, or `--browser firefox`
/`--browser webkit` to run against a different engine (all three ship with
Playwright, no extra setup).

## Adding a test

- Put it in `tests/e2e/`, name it `test_*.py` - pytest picks it up
  automatically (see `pytest.ini`).
- Use the `live_server` fixture for the base URL and `page` (from
  `pytest-playwright`) to drive the browser - see `helpers.py` for the
  `go_to_landing`/`wait_for_active_view` pattern already in use.
- Assert `console_errors == []` at the end of anything that should have zero
  console errors - see `conftest.py` if you need to extend the
  ignore-list for a new class of expected-and-harmless message (extend it
  only for something genuinely expected, never to silence a real failure).
- If a test needs a live Supabase backend, it doesn't belong in this suite
  yet - flag it instead of writing something that'll be flaky in CI.
