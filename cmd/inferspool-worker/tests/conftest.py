"""Shared test helpers: Postgres discovery and fixture setup.

psql is located via PATH (with a few common install prefixes as fallback), so
the suite runs on any machine rather than only where it was written.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

DB = os.getenv("INFERSPOOL_TEST_DB", "inferspool_test")

# Homebrew and Postgres.app keep psql out of the default PATH on macOS; Debian
# hides it under /usr/lib/postgresql/<version>/bin.
_FALLBACK_DIRS = [
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/usr/lib/postgresql/16/bin",
    "/usr/lib/postgresql/15/bin",
]


def find_psql() -> str:
    if override := os.getenv("INFERSPOOL_PSQL"):
        return override
    if found := shutil.which("psql"):
        return found
    for directory in _FALLBACK_DIRS:
        candidate = Path(directory) / "psql"
        if candidate.exists():
            return str(candidate)
    print("psql not found. Install PostgreSQL, add it to PATH, or set "
          "INFERSPOOL_PSQL=/path/to/psql", file=sys.stderr)
    raise SystemExit(2)


PSQL = find_psql()

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"


def sql(query: str, db: str = DB) -> str:
    return subprocess.run([PSQL, "-q", "-At", "-d", db, "-c", query],
                          capture_output=True, text=True, check=True).stdout.strip()


def reset_db(capabilities: str = "{llm,image,video,tts}",
             worker_id: str = "home-gpu", token: str = "tok") -> None:
    """Clean slate: one user, one worker, no jobs."""
    sql("truncate jobs cascade; delete from worker_services; "
        "delete from api_keys; delete from workers; delete from auth.users;")
    sql(f"insert into auth.users (id) values ('{ALICE}'), ('{BOB}')")
    sql(f"insert into workers (id, capabilities, token_hash, last_heartbeat) "
        f"values ('{worker_id}', '{capabilities}', "
        f"extensions.crypt('{token}', extensions.gen_salt('bf')), now())")


def enqueue(job_type: str, payload: dict, user: str = ALICE) -> str:
    return sql(f"insert into jobs (user_id, type, payload) values "
               f"('{user}', '{job_type}', '{json.dumps(payload)}'::jsonb) "
               f"returning id")


def issue_key(user: str = ALICE, label: str = "test") -> str:
    return sql(f"select set_config('request.jwt.claim.sub', '{user}', false); "
               f"select create_api_key('{label}')").splitlines()[-1]


class Checker:
    """Minimal assertion recorder, so a failure does not abort the whole file."""

    def __init__(self) -> None:
        self.failures: list[str] = []

    def __call__(self, condition: object, label: str) -> None:
        print(f"{'ok  ' if condition else 'FAIL'} {label}")
        if not condition:
            self.failures.append(label)

    def report(self, suite: str) -> int:
        print()
        if self.failures:
            print(f"{len(self.failures)} FAILED: {self.failures}")
            return 1
        print(f"{suite} passed.")
        return 0
