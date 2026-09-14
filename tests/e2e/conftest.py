"""Shared fixtures for the browser-driven smoke-test suite.

Starts dev_server.py (the project's own no-cache static server - see
CLAUDE.md's "Running it" section) as a real subprocess for the test
session, on a free port so it never collides with a dev_server someone
already has open on 3000. No Node/npm anywhere in this suite - Playwright
for Python + pytest, matching this project's Python-only tooling
convention (dev_server.py itself is Python for the same reason).

These tests deliberately do NOT require a live Supabase backend (local
Docker or hosted) - they cover client-side rendering/navigation/CSS
correctness only, which is exactly the class of bug this suite exists to
catch (see tests/e2e/README.md). console_errors() filters out the
Supabase-connection-refused noise that's expected and harmless when no
backend is running, so a real assertion failure means a real problem.
"""
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Console/network noise that's expected with no Supabase backend reachable
# (this suite's whole point - see the module docstring) or otherwise
# harmless and unrelated to what these tests check. Extend this if a new,
# genuinely-expected-and-harmless message shows up - never widen it just to
# silence a real failure.
_IGNORED_ERROR_PATTERNS = [
    re.compile(r"127\.0\.0\.1:54321"),
    re.compile(r"ERR_CONNECTION_REFUSED"),
    re.compile(r"Failed to load resource.*127\.0\.0\.1"),
    re.compile(r"favicon\.ico"),
    # A raw, unconsumed console format string ("%c%d font-size:0;color:
    # transparent NaN") observed coming from page load itself, before any
    # test interaction - consistent with a third-party script's own
    # internal/anti-fraud logging (Cloudflare Turnstile's challenge script
    # and/or its Web Analytics beacon are both loaded unconditionally, see
    # index.html's CSP script-src) rather than anything in this app's own
    # code. Not traced to an exact source file - flagged here rather than
    # silently ignored so a future pass can pin it down for real.
    re.compile(r"%c%d font-size:0"),
]


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def live_server():
    port = _free_port()
    env = os.environ.copy()
    env["PORT"] = str(port)
    proc = subprocess.Popen(
        [sys.executable, "dev_server.py"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.1)
    else:
        proc.terminate()
        raise RuntimeError("dev_server.py did not start within 10s")

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def console_errors(page):
    """Collects real console errors/page exceptions for the test's page,
    filtered to exclude expected no-backend noise (see module docstring).
    Usage: assert console_errors == [] at the end of a test, after
    whatever navigation/interaction the test performs."""
    errors = []

    def on_console(msg):
        if msg.type != "error":
            return
        text = msg.text
        if any(p.search(text) for p in _IGNORED_ERROR_PATTERNS):
            return
        errors.append(text)

    def on_pageerror(exc):
        errors.append(str(exc))

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    return errors
