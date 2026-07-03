#!/usr/bin/env python3
"""CI-capable reality test: drive tsforge in a REAL pseudo-terminal against a REAL
(local, deterministic) OpenAI-compatible model server, and assert on the real byte
stream. No GUI, no external model — so it runs anywhere (Linux CI included) and is
deterministic, yet it exercises the real process, the real ANSI stream, the real
policy layer, and the real tool execution — none of the in-process fakes that have
given false confidence before.

It is the headless sibling of scripts/e2e-iterm-plan-mode.py (which is the
high-fidelity GUI pass on macOS + a real model). What this CANNOT test is GUI
resize-reflow (that needs a real terminal emulator) — that stays the iTerm2 suite's job.

Scenario: the plan-first lifecycle.
  boot (plan mode default) -> ask for a write
    -> model returns a `## Plan` (no tools); assert NO file written (read-only)
  'approve' -> model returns a `create` tool call
    -> assert the file is written with the right content, tools were unlocked

Run: python3 scripts/e2e-pty.py
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO, "packages/core/src/cli.ts")
MODEL = "stub-model"
SUM_BODY = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n"

# --- deterministic OpenAI-compatible model server ---------------------------


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n".encode()


def _content_chunks(text):
    yield _sse({"choices": [{"index": 0, "delta": {"content": text}}]})


def _toolcall_chunks(name, args):
    yield _sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": name, "arguments": json.dumps(args)},
                            }
                        ]
                    },
                }
            ]
        }
    )


def _decide(messages):
    """The whole scenario logic — pick the response from the conversation state."""
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        # The create already ran; end the drive loop with a plain final answer.
        return _content_chunks("Done — created src/sum.ts.")

    joined = " ".join(
        m.get("content") or "" for m in messages if isinstance(m.get("content"), str)
    )
    if "plan is APPROVED" in joined:
        return _toolcall_chunks("create", {"file": "src/sum.ts", "content": SUM_BODY})

    return _content_chunks(
        "## Plan\n\n1. Create `src/sum.ts` exporting "
        "`sum(a: number, b: number): number` that returns `a + b`.\n"
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # silence
        pass

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": MODEL,
                            "object": "model",
                            "owned_by": "stub",
                            "max_model_len": 32768,
                        }
                    ],
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            req = {}
        messages = req.get("messages", [])

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for chunk in _decide(messages):
            self.wfile.write(chunk)
        self.wfile.write(
            _sse(
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 8,
                        "total_tokens": 18,
                    },
                }
            )
        )
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


# --- PTY driver -------------------------------------------------------------


def read_until(master, marker, timeout, buf=""):
    """Accumulate the real byte stream until `marker(buf)` is true or timeout."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([master], [], [], 0.3)
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            buf += data.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf


def main():
    ok = True
    srv, port = start_server()
    work = tempfile.mkdtemp(prefix="tsforge-pty-")
    home = tempfile.mkdtemp(prefix="tsforge-home-")
    target = os.path.join(work, "src", "sum.ts")
    print(f"stub model @ 127.0.0.1:{port}  workdir={work}")

    pid, master = pty.fork()
    if pid == 0:  # child: become tsforge in the pty
        os.chdir(work)
        env = dict(os.environ)
        env.update(
            {
                "TSFORGE_BASE_URL": f"http://127.0.0.1:{port}/v1",
                "TSFORGE_MODEL": MODEL,
                "TSFORGE_HOME": home,
                "TSFORGE_NO_UPDATE_CHECK": "1",
                "TSFORGE_BASIC_INPUT": "1",  # readline path; GUI editor is the iTerm2 suite's job
            }
        )
        os.execvpe("bun", ["bun", CLI, "--no-gate"], env)
        os._exit(127)

    # parent: set a real window size, then drive.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    try:
        got, buf = read_until(
            master, lambda b: "plan mode (default)" in b or "PLAN" in b, 60
        )
        print(f"  [{'PASS' if got else 'FAIL'}] boots into plan mode by default (real pty)")
        ok &= got

        os.write(
            master,
            b"Create a new file src/sum.ts exporting a sum(a,b) that returns a+b.\r",
        )
        got, buf = read_until(
            master, lambda b: "reply to refine" in b or "## Plan" in b, 60, buf
        )
        wrote_early = os.path.exists(target)
        print(f"  [{'PASS' if got else 'FAIL'}] model returned a plan in plan mode")
        print(
            f"  [{'PASS' if not wrote_early else 'FAIL'}] NO file written during plan mode "
            f"(read-only)   file_exists={wrote_early}"
        )
        ok &= got and (not wrote_early)

        os.write(master, b"approve\r")
        got, buf = read_until(master, lambda b: "plan approved" in b.lower(), 30, buf)
        print(f"  [{'PASS' if got else 'FAIL'}] 'approve' hit the approval gate")
        ok &= got

        deadline = time.monotonic() + 30
        while not os.path.exists(target) and time.monotonic() < deadline:
            # Keep draining the stream (and preserve it in buf for debugging) while
            # we wait for the write; strings are immutable so we must reassign buf.
            _, buf = read_until(master, lambda _b: False, 0.5, buf)
        wrote = os.path.exists(target)
        print(f"  [{'PASS' if wrote else 'FAIL'}] file written AFTER approve   file_exists={wrote}")
        ok &= wrote
        if wrote:
            with open(target) as f:
                body = f.read()
            good = "function sum" in body
            print(f"  [{'PASS' if good else 'FAIL'}] implemented file contains `function sum`")
            ok &= good
    finally:
        try:
            os.write(master, b"/exit\r")
            time.sleep(0.3)
        except OSError:
            pass
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        srv.shutdown()

    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
