"""End-to-end tests for the compiled Go worker.

Python only supplies local Postgres/HTTP fixtures. All production behavior —
probing, claiming, heartbeat, handlers, uploads and draining — runs in the Go
binary that is shipped to GPU hosts.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WORKER))

from conftest import ALICE, Checker, enqueue, reset_db, sql  # noqa: E402
from fake_postgrest import Handler as PostgrestHandler       # noqa: E402
from fake_postgrest import serve as serve_pg                 # noqa: E402
import stub_backends as stubs                                # noqa: E402

check = Checker()


def wait_for(job_id: str, statuses: tuple[str, ...], timeout: float = 45) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = sql(f"select status from jobs where id='{job_id}'")
        if status in statuses:
            return status
        time.sleep(0.2)
    return sql(f"select status from jobs where id='{job_id}'")


def wait_until(predicate, timeout: float = 30) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def build_worker(directory: Path) -> Path:
    binary = directory / "inferspool-worker"
    subprocess.run(["go", "build", "-o", binary, "."], cwd=WORKER, check=True)
    return binary


class WorkerProcess:
    def __init__(self, binary: Path, pg_url: str, urls: dict[str, str],
                 extra: dict[str, str] | None = None) -> None:
        env = {key: value for key, value in os.environ.items()
               if key not in ("INFERSPOOL_DIRECT_LISTEN",
                              "INFERSPOOL_DIRECT_URL",
                              "INFERSPOOL_DIRECT_TTL_SECS")
               and not (key.startswith("INFERSPOOL_") and key.endswith(
                   ("_LAUNCH", "_STOP", "_CWD", "_READY_TIMEOUT",
                    "_IDLE_TIMEOUT", "_WARMUP_SECS", "_WORKFLOW")))}
        env.update({
            "INFERSPOOL_URL": pg_url,
            "INFERSPOOL_GATEWAY_KEY": "anon",
            "INFERSPOOL_WORKER_ID": "home-gpu",
            "INFERSPOOL_WORKER_TOKEN": "tok",
            "INFERSPOOL_LLM_URL": urls["llm"],
            "INFERSPOOL_IMAGE_URL": urls["image"],
            "INFERSPOOL_VIDEO_URL": urls["video"],
            "INFERSPOOL_TTS_URL": urls["tts"],
            "INFERSPOOL_LLM_CAPACITY": "4",
            "INFERSPOOL_TTS_CAPACITY": "2",
            "INFERSPOOL_LEASE_SECS": "8",
            "INFERSPOOL_HEARTBEAT_SECS": "1",
            "INFERSPOOL_IDLE_POLL_SECS": "0.2",
            "INFERSPOOL_REPORT_SECS": "0.4",
            "INFERSPOOL_REQUEST_TIMEOUT": "30",
            "INFERSPOOL_LOG_LEVEL": "ERROR",
        })
        if extra:
            env.update(extra)
        self.log = tempfile.TemporaryFile(mode="w+")
        self.process = subprocess.Popen([binary, "run"], env=env,
                                        stdout=self.log, stderr=self.log)

    def stop(self, timeout: float = 40) -> None:
        if self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)

    def diagnostics(self) -> str:
        self.log.seek(0)
        return self.log.read()[-5000:]


def request_cancel(job_id: str) -> None:
    sql(f"select set_config('request.jwt.claim.sub', '{ALICE}', false); "
        f"select request_cancel('{job_id}')")


def main() -> int:
    _, pg_url = serve_pg()
    _, llm_url = stubs.serve_llm()
    _, image_url = stubs.serve_image()
    _, video_url = stubs.serve_video()
    _, tts_url = stubs.serve_tts()
    urls = {"llm": llm_url, "image": image_url, "video": video_url,
            "tts": tts_url}

    with tempfile.TemporaryDirectory() as temp:
        binary = build_worker(Path(temp))
        run_core_scenarios(binary, pg_url, urls)
        run_direct_result_scenario(binary, pg_url, urls)
        run_on_demand_scenario(binary, pg_url, urls, Path(temp))
    return check.report("Go worker end-to-end tests")


def run_core_scenarios(binary: Path, pg_url: str,
                       urls: dict[str, str]) -> None:
    reset_db()
    PostgrestHandler.uploads.clear()
    stubs.LlmState.models = ["stub-model"]
    stubs.LlmState.tokens = 4
    stubs.LlmState.token_delay = 0.01
    stubs.LlmState.fail_completions = 0
    stubs.LlmState.last_request = None
    stubs.ImageState.healthy = False
    stubs.ImageState.delay = 0.05
    stubs.VideoState.healthy = True
    stubs.VideoState.delay = 0.05
    stubs.TtsState.healthy = True
    stubs.TtsState.delay = 0.05

    image = enqueue("image", {"prompt": "blue hour", "seed": 42})
    video = enqueue("video", {"prompt": "clouds over a city", "seconds": 2})
    llm = enqueue("llm", {"prompt": "hello"})
    speech = enqueue("tts", {"text": "read this"})
    worker = WorkerProcess(binary, pg_url, urls)
    try:
        check(wait_for(llm, ("succeeded",)) == "succeeded",
              "LLM streams through the Go handler")
        check(wait_for(speech, ("succeeded",)) == "succeeded",
              "TTS audio runs through the Go handler")
        check(wait_for(video, ("succeeded",)) == "succeeded",
              "video runs through the vLLM-Omni sync API")
        check(sql(f"select status from jobs where id='{image}'") == "queued",
              "a down backend leaves its work queued")
        check(sql(f"select attempts from jobs where id='{image}'") == "0",
              "a down backend burns no attempt")

        stubs.ImageState.healthy = True
        check(wait_for(image, ("succeeded",), 60) == "succeeded",
              "queued image work resumes when vLLM-Omni recovers")
        check(sql(f"select result->>'text' from jobs where id='{llm}'").startswith("tok"),
              "streamed LLM output is persisted")
        check(sql(f"select result->'artifacts'->0->>'mime' from jobs where id='{speech}'")
              == "audio/wav", "TTS result records its private audio upload")
        check(sql(f"select result->'artifacts'->0->>'mime' from jobs where id='{image}'")
              == "image/png", "image output is uploaded to private Storage")
        check(sql(f"select result->'artifacts'->0->>'mime' from jobs where id='{video}'")
              == "video/mp4", "video output is uploaded to private Storage")
        check(stubs.ImageState.last_request.get("response_format") == "b64_json",
              "image requests use the vLLM-Omni base64 response format")
        check(stubs.TtsState.last_request.get("input") == "read this",
              "TTS requests use the OpenAI-compatible input field")
        check(stubs.TtsState.last_request.get("response_format") == "opus",
              "TTS defaults to compressed Opus output")
        check(len(PostgrestHandler.uploads) >= 3,
              "signed uploads carry image, video and audio bytes")
        check(wait_until(lambda: sql("select count(*) from worker_services") == "4"),
              "all configured services are reported")

        reset_db()
        input_path = f"{ALICE}/vision/input.png"
        PostgrestHandler.uploads[input_path] = b"fake-png"
        vision = enqueue("llm", {"prompt": "describe this", "images": [{
            "bucket": "inputs", "path": input_path, "mime": "image/png",
            "filename": "input.png", "bytes": 8,
        }]})
        check(wait_for(vision, ("succeeded",), 45) == "succeeded",
              "multimodal LLM task completes")
        content = ((stubs.LlmState.last_request or {}).get("messages") or [{}])[0].get("content")
        check(isinstance(content, list) and content[0].get("type") == "text"
              and content[1].get("type") == "image_url"
              and "/input/" in content[1].get("image_url", {}).get("url", ""),
              "worker sends text and a lease-scoped image URL to vLLM")

        reset_db()
        stubs.LlmState.max_concurrent = 0
        stubs.LlmState.tokens = 15
        stubs.LlmState.token_delay = 0.03
        jobs = [enqueue("llm", {"prompt": f"q{i}"}) for i in range(4)]
        check(all(wait_for(job, ("succeeded",), 45) == "succeeded" for job in jobs),
              "a whole claimed batch completes")
        check(stubs.LlmState.max_concurrent > 1,
              f"batch requests overlap (max {stubs.LlmState.max_concurrent})")

        reset_db()
        stubs.LlmState.tokens = 300
        stubs.LlmState.token_delay = 0.03
        long_job = enqueue("llm", {"prompt": "cancel me"})
        check(wait_for(long_job, ("running",), 20) == "running",
              "long LLM job is claimed")
        request_cancel(long_job)
        check(wait_for(long_job, ("canceled",), 30) == "canceled",
              "batch heartbeat cancels streaming generation")

        reset_db()
        stubs.LlmState.tokens = 4
        stubs.LlmState.token_delay = 0.01
        stubs.ImageState.delay = 100
        image_job = enqueue("image", {"prompt": "cancel me"})
        check(wait_for(image_job, ("running",), 20) == "running",
              "long vLLM-Omni image job is claimed")
        request_cancel(image_job)
        check(wait_for(image_job, ("canceled",), 30) == "canceled",
              "canceling a task closes its synchronous Omni request")

        reset_db()
        stubs.ImageState.delay = 0.05
        bad = enqueue("llm", {})
        check(wait_for(bad, ("failed",), 30) == "failed",
              "missing input is rejected")
        check(sql(f"select attempts from jobs where id='{bad}'") == "1",
              "permanent input errors consume one attempt")

        reset_db()
        stubs.LlmState.fail_completions = 10
        failed = enqueue("llm", {"prompt": "backend error"})
        check(wait_for(failed, ("failed",), 60) == "failed",
              "transient backend failures exhaust bounded attempts")
        check(sql(f"select attempts from jobs where id='{failed}'") == "3",
              "transient failures use all configured attempts")
        stubs.LlmState.fail_completions = 0
    finally:
        worker.stop()
        check(worker.process.returncode == 0,
              "SIGTERM drains the Go worker cleanly")
        check(sql("select count(*) from worker_services where healthy") == "0",
              "clean drain reports every service offline")
        if worker.process.returncode != 0:
            print(worker.diagnostics(), file=sys.stderr)


def run_on_demand_scenario(binary: Path, pg_url: str, urls: dict[str, str],
                           directory: Path) -> None:
    reset_db()
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    service = directory / "ondemand.py"
    service.write_text(
        "import sys\n"
        f"sys.path[:0] = [{str(WORKER)!r}, {str(HERE)!r}]\n"
        "import stub_backends as s\n"
        "s.LlmState.tokens = 3\n"
        f"server, _ = s._serve(s.LlmHandler, {port})\n"
        "server.serve_forever()\n")
    launch_url = f"http://127.0.0.1:{port}"
    local_urls = {**urls, "llm": launch_url}
    worker = WorkerProcess(binary, pg_url, local_urls, {
        "INFERSPOOL_IMAGE_URL": "",
        "INFERSPOOL_TTS_URL": "",
        "INFERSPOOL_LLM_LAUNCH": f"{sys.executable} {service}",
        "INFERSPOOL_LLM_READY_TIMEOUT": "20",
        "INFERSPOOL_LLM_WARMUP_SECS": "0.2",
        "INFERSPOOL_LLM_IDLE_TIMEOUT": "1",
        "INFERSPOOL_STOP_GRACE_SECS": "3",
    })
    try:
        job = enqueue("llm", {"prompt": "wake up"})
        check(wait_for(job, ("succeeded",), 40) == "succeeded",
              "queued work starts an on-demand backend")
        check(wait_until(lambda: not port_open(port), 15),
              "idle timeout stops the managed backend")
    finally:
        worker.stop()


def run_direct_result_scenario(binary: Path, pg_url: str,
                               urls: dict[str, str]) -> None:
    reset_db()
    PostgrestHandler.uploads.clear()
    stubs.ImageState.healthy = True
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    direct_url = f"http://127.0.0.1:{port}"
    worker = WorkerProcess(binary, pg_url, urls, {
        "INFERSPOOL_DIRECT_LISTEN": f"127.0.0.1:{port}",
        "INFERSPOOL_DIRECT_URL": direct_url,
        "INFERSPOOL_DIRECT_TTL_SECS": "60",
    })
    try:
        check(wait_until(lambda: sql(
            "select parameter_schema->'_result_delivery'->'enum' ? 'direct' "
            "from worker_services where worker_id='home-gpu' and type='image'"
        ) == "t", 20), "worker advertises direct result delivery")
        job = enqueue("image", {
            "prompt": "LAN result", "_result_delivery": "direct",
        })
        check(wait_for(job, ("succeeded",), 45) == "succeeded",
              "direct image task completes")
        url = sql(f"select result->'artifacts'->0->>'url' from jobs where id='{job}'")
        check(url.startswith(direct_url + "/result/"),
              "direct result points to the configured worker address")
        with urllib.request.urlopen(url, timeout=10) as response:
            body = response.read()
        check(response.status == 200 and len(body) > 20,
              "browser can download the result directly from the worker")
        check(not PostgrestHandler.uploads,
              "direct result bypasses cloud Storage upload")
    finally:
        worker.stop()


def port_open(port: int) -> bool:
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
