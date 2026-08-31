"""Crash recovery test for the compiled Go worker.

The process must really die: an in-process shutdown cannot prove that an
unrenewed lease is reclaimed. Local Python code only supplies the HTTP and
PostgREST fixtures.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WORKER))

from conftest import Checker, enqueue, reset_db, sql  # noqa: E402
from fake_postgrest import serve as serve_pg          # noqa: E402
import stub_backends as stubs                         # noqa: E402

check = Checker()


def start_worker(binary: Path, pg_url: str, llm_url: str) -> subprocess.Popen:
    env = {**os.environ,
           "INFERSPOOL_URL": pg_url, "INFERSPOOL_GATEWAY_KEY": "anon",
           "INFERSPOOL_WORKER_ID": "home-gpu",
           "INFERSPOOL_WORKER_TOKEN": "tok",
           "INFERSPOOL_LLM_URL": llm_url,
           "INFERSPOOL_LEASE_SECS": "5", "INFERSPOOL_HEARTBEAT_SECS": "1",
           "INFERSPOOL_IDLE_POLL_SECS": "0.2",
           "INFERSPOOL_REPORT_SECS": "0.4",
           "INFERSPOOL_LOG_LEVEL": "ERROR"}
    return subprocess.Popen([binary, "run"], env=env,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)


def wait_status(job_id: str, wanted: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sql(f"select status from jobs where id='{job_id}'") == wanted:
            return True
        time.sleep(0.2)
    return False


def main() -> int:
    _, pg_url = serve_pg()
    _, llm_url = stubs.serve_llm()
    reset_db(capabilities="{llm}")
    job_id = enqueue("llm", {"prompt": "long running"})
    stubs.LlmState.tokens = 400
    stubs.LlmState.token_delay = 0.05

    with tempfile.TemporaryDirectory() as temp:
        binary = Path(temp) / "inferspool-worker"
        subprocess.run(["go", "build", "-o", binary, "."],
                       cwd=WORKER, check=True)
        process = start_worker(binary, pg_url, llm_url)
        try:
            check(wait_status(job_id, "running", 25),
                  "the Go worker process claimed the job")
            time.sleep(2.5)
            check(sql(f"select lease_expires_at > now() from jobs "
                      f"where id='{job_id}'") == "t",
                  "the batch heartbeat holds the lease")

            process.send_signal(signal.SIGKILL)
            process.wait(timeout=10)
            check(sql(f"select status from jobs where id='{job_id}'") == "running",
                  "the job stays running immediately after SIGKILL")

            time.sleep(6)
            sql("select claim_jobs('home-gpu', 'tok', null, 4, 60)")
            check(sql(f"select status from jobs where id='{job_id}'")
                  in ("queued", "running"),
                  "an expired lease is reclaimed after a crash")

            sql(f"update jobs set can_start_at = now() where id='{job_id}'")
            stubs.LlmState.tokens = 3
            restarted = start_worker(binary, pg_url, llm_url)
            try:
                check(wait_status(job_id, "succeeded", 90),
                      "a restarted Go worker completes the recovered job")
                check(int(sql(f"select attempts from jobs where id='{job_id}'")) >= 2,
                      "recovery counted as a new attempt")
            finally:
                restarted.terminate()
                restarted.wait(timeout=30)
        finally:
            if process.poll() is None:
                process.kill()
            stubs.LlmState.tokens = 4
            stubs.LlmState.token_delay = 0.01

    return check.report("Go worker recovery tests")


if __name__ == "__main__":
    raise SystemExit(main())
