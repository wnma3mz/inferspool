"""Fake inference backends for the worker integration tests.

Real handlers run against these unchanged, so the queue, leases, progress
reporting and cancellation can be proven end to end on a laptop with no GPU.
The test suite imports the same servers.
"""

from __future__ import annotations

import base64
import json
import sys
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class LlmState:
    """Knobs the tests use to simulate failure and slow generation."""

    healthy = True
    models = ["stub-model"]
    tokens = 6
    token_delay = 0.05
    fail_completions = 0
    concurrent = 0
    max_concurrent = 0
    lock = threading.Lock()
    last_request: dict | None = None


class OmniState:
    healthy = True
    models = ["stub-omni-model"]
    fail = False
    delay = 0.05
    last_request: dict | None = None


class ImageState(OmniState):
    pass


class VideoState(OmniState):
    pass


class TtsState(OmniState):
    pass


def _send_json(h: BaseHTTPRequestHandler, status: int, body: object) -> None:
    payload = json.dumps(body).encode()
    h.send_response(status)
    h.send_header("Content-Type", "application/json")
    h.send_header("Content-Length", str(len(payload)))
    h.end_headers()
    h.wfile.write(payload)


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """Minimal solid-colour PNG, so a stub returns a real viewable image."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class LlmHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible: /v1/models and streaming chat."""

    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/v1/models":
            self.send_error(404)
            return
        if not LlmState.healthy:
            _send_json(self, 503, {"error": "server not ready"})
            return
        _send_json(self, 200, {"data": [{"id": m} for m in LlmState.models]})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        if not LlmState.healthy:
            _send_json(self, 503, {"error": "server not ready"})
            return

        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        LlmState.last_request = body

        if LlmState.fail_completions > 0:
            LlmState.fail_completions -= 1
            _send_json(self, 500, {"error": "simulated failure"})
            return

        # Track overlap, so a test can prove the batch really runs concurrently.
        with LlmState.lock:
            LlmState.concurrent += 1
            LlmState.max_concurrent = max(LlmState.max_concurrent,
                                          LlmState.concurrent)
        try:
            self._stream()
        finally:
            with LlmState.lock:
                LlmState.concurrent -= 1

    def _stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(data: str) -> None:
            block = f"data: {data}\n\n".encode()
            self.wfile.write(f"{len(block):X}\r\n".encode() + block + b"\r\n")
            self.wfile.flush()

        try:
            for i in range(LlmState.tokens):
                time.sleep(LlmState.token_delay)
                chunk(json.dumps({"choices": [{"delta": {"content": f"tok{i} "}}]}))
            chunk("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass    # client hung up, e.g. after a cancel

    def log_message(self, *args: object) -> None:
        pass


class OmniHandler(BaseHTTPRequestHandler):
    """The vLLM-Omni model list, image, video and speech APIs."""

    protocol_version = "HTTP/1.1"
    state: type[OmniState]
    kind: str

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/v1/models":
            self.send_error(404)
            return
        if not self.state.healthy:
            _send_json(self, 503, {"error": "loading"})
            return
        _send_json(self, 200, {"data": [{"id": model}
                                        for model in self.state.models]})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        if not self.state.healthy:
            _send_json(self, 503, {"error": "loading"})
            return
        if self.state.fail:
            _send_json(self, 500, {"error": "generation failed"})
            return

        if self.kind == "video":
            self.state.last_request = {"multipart": raw.decode(errors="replace")}
        else:
            self.state.last_request = json.loads(raw or b"{}")
        time.sleep(self.state.delay)

        expected = {"image": "/v1/images/generations",
                    "video": "/v1/videos/sync",
                    "tts": "/v1/audio/speech"}[self.kind]
        if self.path != expected:
            self.send_error(404)
            return
        if self.kind == "image":
            image = base64.b64encode(_png(16, 16, (20, 90, 180))).decode()
            _send_json(self, 200, {"created": int(time.time()),
                                   "data": [{"b64_json": image, "url": None}]})
            return
        if self.kind == "video":
            self._send_bytes("video/mp4", b"\x00\x00\x00\x18ftypmp42stub-video")
            return
        self._send_bytes("audio/wav",
                         b"RIFF$\x00\x00\x00WAVEfmt " + b"\x00" * 24)

    def _send_bytes(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args: object) -> None:
        pass


class StubServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        if isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def _serve(handler: type[BaseHTTPRequestHandler],
           port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    server = StubServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def serve_llm(port: int = 0):
    return _serve(LlmHandler, port)


def _serve_omni(state: type[OmniState], kind: str, port: int = 0):
    handler = type(f"{kind.title()}OmniHandler", (OmniHandler,),
                   {"state": state, "kind": kind})
    return _serve(handler, port)


def serve_image(port: int = 0):
    return _serve_omni(ImageState, "image", port)


def serve_video(port: int = 0):
    return _serve_omni(VideoState, "video", port)


def serve_tts(port: int = 0):
    return _serve_omni(TtsState, "tts", port)


def start_stubs() -> dict[str, str]:
    """Start one of each and return the backend environment variables."""
    _, llm = serve_llm()
    _, image = serve_image()
    _, video = serve_video()
    _, tts = serve_tts()
    return {
        "INFERSPOOL_LLM_URL": llm,
        "INFERSPOOL_IMAGE_URL": image,
        "INFERSPOOL_VIDEO_URL": video,
        "INFERSPOOL_TTS_URL": tts,
    }


if __name__ == "__main__":
    urls = start_stubs()
    for key, value in urls.items():
        print(f"{key}={value}")
    print("\nstub backends running; Ctrl-C to stop")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
