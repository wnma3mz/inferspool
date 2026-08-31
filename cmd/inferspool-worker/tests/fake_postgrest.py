"""Minimal PostgREST stand-in over the local test database.

Translates POST /rest/v1/rpc/<fn> into a SQL call against inferspool_test, mirroring
how PostgREST surfaces SQLSTATEs in its JSON error body. This lets the real
worker code run against the real migration with no cloud involved.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from conftest import DB, PSQL

# Argument order per function, since SQL named-arg order must be explicit.
SIGNATURES = {
    # worker plane
    "claim_jobs": ["p_worker_id", "p_token", "p_types", "p_limit", "p_lease_secs"],
    "heartbeat_batch": ["p_worker_id", "p_token", "p_job_ids", "p_lease_secs"],
    "progress_batch": ["p_worker_id", "p_token", "p_updates"],
    "complete_job": ["p_worker_id", "p_token", "p_job_id", "p_result"],
    "fail_job": ["p_worker_id", "p_token", "p_job_id", "p_error", "p_retryable"],
    "report_services": ["p_worker_id", "p_token", "p_services"],
    "pending_by_type": ["p_worker_id", "p_token"],
    "worker_upload_target": ["p_worker_id", "p_token", "p_job_id"],
    "worker_input_target": ["p_worker_id", "p_token", "p_job_id", "p_bucket", "p_path"],
    # client plane
    "submit_job": ["p_key", "p_type", "p_payload", "p_priority",
                   "p_idempotency_key"],
    "list_jobs": ["p_key", "p_limit", "p_status"],
    "get_job": ["p_key", "p_job_id"],
    "cancel_job_by_key": ["p_key", "p_job_id"],
    "queue_stats": [],
    "client_download_target": ["p_key", "p_job_id", "p_bucket", "p_path"],
    "client_input_owner": ["p_key"],
    "retry_job_by_key": ["p_key", "p_job_id"],
    "request_job_deletion_by_key": ["p_key", "p_job_id"],
}

CASTS = {
    "p_job_id": "uuid", "p_lease_secs": "int", "p_progress": "real",
    "p_result": "jsonb", "p_retryable": "boolean", "p_limit": "int",
    "p_job_ids": "uuid[]", "p_updates": "jsonb", "p_payload": "jsonb",
    "p_priority": "int", "p_status": "job_status", "p_services": "jsonb",
    "p_types": "text[]", "p_bucket": "text", "p_path": "text",
}

# Functions returning a table or setof: PostgREST yields a JSON array.
SETOF = {"claim_jobs", "heartbeat_batch", "list_jobs", "pending_by_type",
         "worker_upload_target", "client_input_owner"}
# Functions returning a single composite row.
ROW = {"submit_job", "get_job", "retry_job_by_key"}
# Functions returning a scalar.
SCALAR = {"progress_batch", "cancel_job_by_key", "queue_stats",
          "client_download_target", "worker_input_target",
          "request_job_deletion_by_key"}


def _lit(name: str, value: object) -> str:
    cast = CASTS.get(name, "text")
    if value is None:
        return f"null::{cast}"
    if isinstance(value, bool):
        return f"{str(value).lower()}::{cast}"
    if isinstance(value, (int, float)):
        return f"{value}::{cast}"
    if cast in ("uuid[]", "text[]") and isinstance(value, list):
        inner = ",".join('"' + str(v).replace('"', '\\"') + '"' for v in value)
        return f"'{{{inner}}}'::{cast}"
    if isinstance(value, (dict, list)):
        value = json.dumps(value)
    escaped = str(value).replace("'", "''")
    return f"'{escaped}'::{cast}"


def call_sql(fn: str, params: dict[str, object]) -> tuple[int, object]:
    args = ", ".join(
        f"{k} => {_lit(k, params.get(k))}" for k in SIGNATURES[fn]
        if k in params
    )

    if fn in ROW:
        # Row-returning function: to_jsonb gives us the whole record.
        sql = f"select coalesce(to_jsonb(j), 'null'::jsonb) from {fn}({args}) j"
    elif fn in SETOF:
        sql = (f"select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) "
               f"from {fn}({args}) t")
    elif fn in SCALAR:
        sql = f"select coalesce(to_jsonb({fn}({args})), 'null'::jsonb)"
    else:
        sql = f"select '{{}}'::jsonb from (select {fn}({args})) _"

    proc = subprocess.run(
        [PSQL, "-q", "-At", "-d", DB, "-c", sql],
        capture_output=True, text=True,
    )

    if proc.returncode != 0:
        err = proc.stderr
        code = m.group(1) if (m := re.search(r"SQLSTATE:? ?(\w{5})", err)) else None
        if code is None:
            # psql prints the message but not the SQLSTATE; recover it from the
            # exception text we raise in SQL.
            code = "28000" if "bad worker credentials" in err else (
                "P0002" if "lease lost" in err else "P0001")
        return 400, {"code": code, "message": err.strip().splitlines()[-1][:300]}

    out = proc.stdout.strip()
    return 200, json.loads(out) if out else None


class Handler(BaseHTTPRequestHandler):
    uploads: dict[str, bytes] = {}

    def do_POST(self) -> None:  # noqa: N802
        product = self._product_post()
        if product:
            return
        if self.path == "/functions/v1/sign-input-upload":
            length = int(self.headers.get("Content-Length", 0))
            params = json.loads(self.rfile.read(length) or b"{}")
            status, owners = call_sql("client_input_owner", {"p_key": params.get("api_key")})
            if status != 200 or not owners:
                self._json(401, {"error": "invalid API key"})
                return
            owner = owners[0].get("user_id") if isinstance(owners[0], dict) else owners[0]
            name = re.sub(r"[^a-zA-Z0-9._-]", "_", params["filename"])
            path = f"{owner}/test/{name}"
            host = f"http://127.0.0.1:{self.server.server_port}"
            self._json(200, {"bucket": "inputs", "path": path, "mime": params["content_type"],
                             "filename": name, "signed_url": f"{host}/signed/{urllib.parse.quote(path)}"})
            return
        if self.path == "/functions/v1/sign-input-download":
            length = int(self.headers.get("Content-Length", 0))
            params = json.loads(self.rfile.read(length) or b"{}")
            status, allowed = call_sql("worker_input_target", {
                "p_worker_id": params.get("worker_id"), "p_token": params.get("worker_token"),
                "p_job_id": params.get("job_id"), "p_bucket": params.get("bucket"),
                "p_path": params.get("path"),
            })
            if status != 200 or allowed is not True:
                self._json(404, {"error": "input not found"})
                return
            host = f"http://127.0.0.1:{self.server.server_port}"
            self._json(200, {"url": f"{host}/input/{urllib.parse.quote(params['path'])}", "expires_in": 600})
            return
        if self.path == "/functions/v1/sign-result-download":
            length = int(self.headers.get("Content-Length", 0))
            params = json.loads(self.rfile.read(length) or b"{}")
            status, allowed = call_sql("client_download_target", {
                "p_key": params.get("api_key"), "p_job_id": params.get("job_id"),
                "p_bucket": params.get("bucket"), "p_path": params.get("path"),
            })
            if status != 200 or allowed is not True:
                self._json(404, {"error": "result not found"})
                return
            self._json(200, {"url": "https://download.test/" +
                             urllib.parse.quote(params["path"]), "expires_in": 3600})
            return
        if self.path == "/functions/v1/sign-result-upload":
            length = int(self.headers.get("Content-Length", 0))
            params = json.loads(self.rfile.read(length) or b"{}")
            status, owners = call_sql("worker_upload_target", {
                "p_worker_id": params.get("worker_id"),
                "p_token": params.get("worker_token"),
                "p_job_id": params.get("job_id"),
            })
            if status != 200 or not owners:
                self._json(409, {"error": "job lease is not owned"})
                return
            owner = (owners[0].get("user_id") if isinstance(owners[0], dict)
                     else owners[0])
            name = re.sub(r"[^a-zA-Z0-9._-]", "_", params["filename"])
            path = f"{owner}/{params['job_id']}/test-{name}"
            host = f"http://127.0.0.1:{self.server.server_port}"
            self._json(200, {"bucket": "results", "path": path,
                             "signed_url": f"{host}/signed/{urllib.parse.quote(path)}"})
            return

        m = re.match(r"^/rest/v1/rpc/(\w+)$", self.path)
        if not m or m.group(1) not in SIGNATURES:
            self.send_error(404, "unknown rpc")
            return

        length = int(self.headers.get("Content-Length", 0))
        params = json.loads(self.rfile.read(length) or b"{}")
        # Functions with no declared params (queue_stats) must be called bare.
        if not SIGNATURES[m.group(1)]:
            params = {}
        status, body = call_sql(m.group(1), params)

        self._json(status, body)

    def _product_post(self) -> bool:
        worker_routes = {
            "/v1/workers/pending": ("pending_by_type", {}),
            "/v1/workers/services": ("report_services", {"services": "p_services"}),
            "/v1/workers/claim": ("claim_jobs", {"types": "p_types", "limit": "p_limit", "lease_secs": "p_lease_secs"}),
            "/v1/workers/heartbeat": ("heartbeat_batch", {"job_ids": "p_job_ids", "lease_secs": "p_lease_secs"}),
            "/v1/workers/progress": ("progress_batch", {"updates": "p_updates"}),
            "/v1/workers/complete": ("complete_job", {"job_id": "p_job_id", "result": "p_result"}),
            "/v1/workers/fail": ("fail_job", {"job_id": "p_job_id", "error": "p_error", "retryable": "p_retryable"}),
        }
        if self.path in worker_routes:
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            fn, mapping = worker_routes[self.path]
            params = {"p_worker_id": self.headers.get("X-Worker-ID"), "p_token": self.headers.get("X-Worker-Token")}
            params.update({target: raw[source] for source, target in mapping.items() if source in raw})
            status, result = call_sql(fn, params)
            self._json(status, result)
            return True
        if self.path == "/v1/inputs":
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            key = self.headers.get("Authorization", "").removeprefix("Bearer ")
            status, owners = call_sql("client_input_owner", {"p_key": key})
            if status != 200 or not owners:
                self._json(401, {"error": {"code": "unauthorized"}}); return True
            owner = owners[0].get("user_id") if isinstance(owners[0], dict) else owners[0]
            name = re.sub(r"[^a-zA-Z0-9._-]", "_", raw["filename"])
            path = f"{owner}/test/{name}"; host = f"http://127.0.0.1:{self.server.server_port}"
            self._json(201, {"bucket": "inputs", "path": path, "mime": raw["content_type"], "filename": name, "signed_url": f"{host}/signed/{urllib.parse.quote(path)}"})
            return True
        if self.path == "/v1/jobs":
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            key = self.headers.get("Authorization", "").removeprefix("Bearer ")
            params = {"p_key": key, "p_type": raw.get("type"), "p_payload": raw.get("payload"),
                      "p_priority": raw.get("priority", 0), "p_idempotency_key": raw.get("idempotency_key")}
            status, result = call_sql("submit_job", params); self._json(201 if status == 200 else status, result); return True
        match = re.match(r"^/v1/jobs/([0-9a-f-]+)/(cancel|retry|keep|result)$", self.path)
        if match:
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            key = self.headers.get("Authorization", "").removeprefix("Bearer ")
            job_id, action = match.groups()
            if action == "cancel":
                status, result = call_sql("cancel_job_by_key", {"p_key": key, "p_job_id": job_id})
                self._json(status if result is not None else 409,
                           {"status": result} if result is not None else {"error": {"code": "not_cancelable"}}); return True
            if action == "retry":
                status, result = call_sql("retry_job_by_key", {"p_key": key, "p_job_id": job_id})
                self._json(201 if status == 200 else status, result); return True
            if action == "keep":
                self._json(200, {"kept": raw.get("keep", True)}); return True
            status, allowed = call_sql("client_download_target", {"p_key": key, "p_job_id": job_id, "p_bucket": raw.get("bucket"), "p_path": raw.get("path")})
            if status != 200 or allowed is not True: self._json(404, {"error": {"code": "not_found"}})
            else: self._json(200, {"url": "https://download.test/" + urllib.parse.quote(raw["path"]), "expires_in": 3600})
            return True
        if self.path == "/v1/workers/results/upload":
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            status, owners = call_sql("worker_upload_target", {"p_worker_id": self.headers.get("X-Worker-ID"), "p_token": self.headers.get("X-Worker-Token"), "p_job_id": raw.get("job_id")})
            if status != 200 or not owners: self._json(409, {"error": {"code": "lease_lost"}}); return True
            owner = owners[0].get("user_id") if isinstance(owners[0], dict) else owners[0]
            name = re.sub(r"[^a-zA-Z0-9._-]", "_", raw["filename"]); path = f"{owner}/{raw['job_id']}/test-{name}"; host = f"http://127.0.0.1:{self.server.server_port}"
            self._json(201, {"bucket": "results", "path": path, "signed_url": f"{host}/signed/{urllib.parse.quote(path)}"}); return True
        if self.path == "/v1/workers/inputs/download":
            raw = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            status, allowed = call_sql("worker_input_target", {"p_worker_id": self.headers.get("X-Worker-ID"), "p_token": self.headers.get("X-Worker-Token"), "p_job_id": raw.get("job_id"), "p_bucket": raw.get("bucket"), "p_path": raw.get("path")})
            if status != 200 or allowed is not True: self._json(404, {"error": {"code": "not_found"}}); return True
            host = f"http://127.0.0.1:{self.server.server_port}"; self._json(200, {"url": f"{host}/input/{urllib.parse.quote(raw['path'])}", "expires_in": 600}); return True
        return False

    def do_PUT(self) -> None:  # noqa: N802
        if not self.path.startswith("/signed/"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        path = urllib.parse.unquote(self.path.removeprefix("/signed/"))
        self.uploads[path] = self.rfile.read(length)
        self._json(200, {"path": path})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/v1/status":
            status, result = call_sql("queue_stats", {}); self._json(status, result); return
        if parsed.path == "/v1/jobs":
            query = urllib.parse.parse_qs(parsed.query); key = self.headers.get("Authorization", "").removeprefix("Bearer ")
            params = {"p_key": key, "p_limit": int(query.get("limit", [20])[0])}
            if query.get("status"): params["p_status"] = query["status"][0]
            status, result = call_sql("list_jobs", params); self._json(status, {"data": result, "next_cursor": None}); return
        match = re.match(r"^/v1/jobs/([0-9a-f-]+)$", parsed.path)
        if match:
            key = self.headers.get("Authorization", "").removeprefix("Bearer ")
            status, result = call_sql("get_job", {"p_key": key, "p_job_id": match.group(1)}); self._json(status if result else 404, result or {"error": {"code": "not_found"}}); return
        if not self.path.startswith("/input/"):
            self.send_error(404)
            return
        path = urllib.parse.unquote(self.path.removeprefix("/input/"))
        body = self.uploads.get(path)
        if body is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self) -> None:  # noqa: N802
        match = re.match(r"^/v1/jobs/([0-9a-f-]+)$", self.path)
        if not match: self.send_error(404); return
        key = self.headers.get("Authorization", "").removeprefix("Bearer ")
        status, result = call_sql("request_job_deletion_by_key", {"p_key": key, "p_job_id": match.group(1)})
        self._json(202 if status == 200 and result else 409, {"deletion_requested": result})

    def _json(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:
        pass   # keep test output readable


def serve(port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


if __name__ == "__main__":
    srv, url = serve(54321)
    print(f"fake postgrest on {url}")
    srv.serve_forever()
