#!/usr/bin/env python3
"""Drive the REAL tsforge REPL (editor mode) in a pty, open /config through the
command palette (the way a user actually does), and exercise the settings hub:
  1. Cancel (Esc) must NOT quit tsforge (the reported quit-on-cancel bug).
  2. Toggle a setting (Mode: plan→normal) and see the live value change.
  3. Add a model via the inline text fields; it persists + tsforge stays alive.
  4. Throughout, tsforge keeps running (no stdin-handoff quit, no key leak).

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


def start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


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


def open_config(m):
    """Open /config via the palette; return (ok, fresh-buffer-after-menu)."""
    os.write(m, b"/")
    ok, _ = read_until(m, lambda b: "model, mode, gate" in b, 10)
    if not ok:
        return False, ""
    os.write(m, b"config\r")
    return read_until(m, lambda b: "change anything here" in b, 10)


RESULTS = []


def check(name, cond):
    RESULTS.append((name, cond))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")


def main():
    srv, port = start_server()
    home = tempfile.mkdtemp(prefix="tsforge-cfgrepl-")
    models_path = os.path.join(home, ".tsforge", "models.json")
    env = dict(
        os.environ,
        TSFORGE_BASE_URL=f"http://127.0.0.1:{port}/v1",
        TSFORGE_MODEL=MODEL,
        TSFORGE_HOME=home,
        TSFORGE_NO_UPDATE_CHECK="1",
    )
    pid, m = pty.fork()
    if pid == 0:
        os.execvpe("bun", ["bun", CLI, "--no-gate"], env)
        os._exit(127)
    fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))

    got, _ = read_until(m, lambda b: "plan mode" in b or "› " in b, 40)
    check("REPL boots", got)

    # 1) open /config, cancel with Esc → must stay alive.
    got, _ = open_config(m)
    check("/config opens the settings hub from the palette", got)
    os.write(m, b"\x1b")  # Esc
    time.sleep(1.2)
    check("tsforge STILL RUNNING after cancel", alive(pid))

    # 2) reopen, toggle Mode (index 2: Active model, Add a model, Mode) → plan→normal.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B\x1b[B")  # ↓↓ to "Mode"
    time.sleep(0.3)
    os.write(m, b"\r")  # toggle
    changed, _ = read_until(m, lambda b: "Mode" in b and "normal" in b, 8)
    check("toggling Mode flips plan→normal (live value)", changed)
    os.write(m, b"\x1b")  # done
    time.sleep(0.8)
    check("tsforge STILL RUNNING after toggle", alive(pid))

    # 3) reopen, Add a model (index 1) via inline text fields.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B")  # ↓ to "Add a model"
    time.sleep(0.3)
    os.write(m, b"\r")  # enter edit
    # Use the unambiguous "field N of 4" counter as the marker (the title
    # "Add a model" itself contains "Model"/"Name", which would false-match).
    steps = [
        ("field 1 of 4", b"repl-model\r"),  # Name
        ("field 2 of 4", b"\r"),  # Base URL — accept the default
        ("field 3 of 4", b"m-repl\r"),  # Model
        ("field 4 of 4", b"\r"),  # API key — optional, empty
    ]
    reached_all = True
    lastbuf = ""
    for marker, keys in steps:
        ok, lastbuf = read_until(m, lambda b, mk=marker: mk in b, 8)
        reached_all = reached_all and ok
        os.write(m, keys)
        time.sleep(0.3)
    check("add-model: all four fields render in the real REPL", reached_all)
    # drain a moment so the async saveModelsConfig flushes, back to menu.
    _, lastbuf = read_until(m, lambda _b: False, 2.0, lastbuf)
    os.write(m, b"\x1b")  # done
    time.sleep(0.8)
    check("tsforge STILL RUNNING after add-model", alive(pid))

    persisted = os.path.exists(models_path) and (
        json.load(open(models_path)).get("active") == "repl-model"
    )
    check("model persisted + active in models.json", persisted)
    if not persisted:
        tdir = os.path.join(home, ".tsforge")
        print(f"      DEBUG home/.tsforge exists={os.path.isdir(tdir)} "
              f"contents={os.listdir(tdir) if os.path.isdir(tdir) else 'NONE'}")
        print("      DEBUG terminal tail:", repr(lastbuf[-400:]))

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
