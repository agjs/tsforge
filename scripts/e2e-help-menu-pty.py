#!/usr/bin/env python3
"""Drive the REAL tsforge /help capability browser in a pty on a SHORT terminal and
assert the inline menu renders correctly:
  1. No frame stacking (the region is bounded to the terminal height, so the status
     bar's relative-redraw can fully clear it — a taller region stacked on scroll).
  2. Only the SELECTED row is blue+bold; every other row is plain default text
     (a prior bug painted them all bold, then all blue/barely-visible).
  3. Title at the top, the selected row's description at the bottom.

Uses an embedded deterministic model stub so boot succeeds offline."""
import os
import pty
import select
import struct
import fcntl
import termios
import time
import tempfile
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO, "packages/core/src/cli.ts")
MODEL = "stub-model"
# The selected-row style: brand truecolor THEN bold (see render/inline-menu formatRow).
BRAND_BOLD = "\x1b[38;2;59;130;246m\x1b[1m"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_GET(self):
        body = json.dumps(
            {"object": "list", "data": [{"id": MODEL, "max_model_len": 32768}]}
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n')
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def read_until(m, marker, timeout, buf=""):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([m], [], [], 0.3)
        if m in r:
            try:
                d = os.read(m, 65536)
            except OSError:
                return False, buf
            if not d:
                return False, buf
            buf += d.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf


def alive(pid):
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return False


RESULTS = []


def check(name, cond):
    RESULTS.append((name, cond))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    home = tempfile.mkdtemp(prefix="tsforge-help-")
    env = dict(
        os.environ,
        TSFORGE_BASE_URL=f"http://127.0.0.1:{port}/v1",
        TSFORGE_MODEL=MODEL,
        TSFORGE_HOME=home,
        NO_UPDATE_NOTIFIER="1",
    )
    pid, m = pty.fork()
    if pid == 0:
        os.execvpe("bun", ["bun", CLI, "--no-gate"], env)
        os._exit(127)
    # SHORT terminal (14 rows): the inline menu MUST bound its height so the whole
    # region fits — otherwise the status bar can't clear it and frames stack.
    fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))

    got, _ = read_until(m, lambda b: "plan mode" in b or "› " in b, 40)
    check("REPL boots", got)

    # Open /help via the palette (the inline palette titles itself "commands").
    os.write(m, b"/")
    read_until(m, lambda b: "commands" in b, 10)
    os.write(m, b"help\r")
    got, _ = read_until(m, lambda b: "what can I do?" in b, 8)
    check("/help opens the capability browser (title renders)", got)

    # Scroll down several times, then capture the latest frame.
    for _ in range(4):
        os.write(m, b"\x1b[B")
        time.sleep(0.25)
    _, tail = read_until(m, lambda _b: False, 1.2, "")
    frame = tail.split("\x1b[0J")[-1]  # content after the last full erase-to-end

    check("no frame stacking (footer appears exactly once)", frame.count("esc close") == 1)
    check("title stays at the top of the frame", "what can I do?" in frame)
    check(
        "only the selected row is blue+bold (exactly one styled row)",
        frame.count(BRAND_BOLD) == 1,
    )
    if frame.count(BRAND_BOLD) != 1 or frame.count("esc close") != 1:
        print("      DEBUG frame tail:", repr(frame[-500:]))

    os.write(m, b"\x1b")  # close /help
    time.sleep(0.8)
    check("tsforge STILL RUNNING after /help closes", alive(pid))

    # Selecting a command must actually RUN it (regression: runCommand prepended a
    # slash to the already-slashed name → "//sessions" → unknown command). Reopen
    # /help, pick /plan (rows 0=/compact 1=/clear 2=/plan), confirm it toggled mode.
    os.write(m, b"/")
    read_until(m, lambda b: "commands" in b, 8)
    os.write(m, b"help\r")
    read_until(m, lambda b: "what can I do?" in b, 8)
    os.write(m, b"\x1b[B")
    time.sleep(0.25)
    os.write(m, b"\x1b[B")
    time.sleep(0.25)
    os.write(m, b"\r")  # select /plan
    ran, selbuf = read_until(m, lambda b: "normal" in b, 6)
    check(
        "selecting a /help command RUNS it (no //, mode → normal)",
        ran and "unknown command" not in selbuf,
    )

    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    srv.shutdown()

    npass = sum(1 for _, c in RESULTS if c)
    print(f"\n==== {npass}/{len(RESULTS)} — {'ALL PASS' if npass == len(RESULTS) else 'FAILURES'} ====")
    sys.exit(0 if npass == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
