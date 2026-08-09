"""Shared infrastructure for the real-PTY e2e suite.

Every e2e-*-pty.py script drives the REAL tsforge process in a REAL
pseudo-terminal and asserts on the real byte stream. This module holds the
plumbing they all share — the poll loop, the deterministic OpenAI-compatible
stub server, PTY spawn/reap, and the pass/fail tally — so each script is only
its scenario.

Import pattern (scripts run as `python3 scripts/e2e-foo.py`):

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    from ptyharness import read_until, start_stub_server, spawn_pty, ...
"""
import fcntl
import json
import os
import pty
import select
import struct
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# scripts/lib/ptyharness.py -> repo root is three levels up.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(REPO, "packages/core/src/cli.ts")
DEFAULT_MODEL = "stub-model"


# --- byte-stream polling ------------------------------------------------------


def read_until(fd, marker, timeout, buf=""):
    """Accumulate the real byte stream until `marker(buf)` is true or timeout.

    Returns (matched, buffer). On EOF / closed PTY returns (False, buffer)
    immediately rather than spinning out the timeout.
    """
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([fd], [], [], 0.3)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False, buf
            if not data:
                return False, buf
            buf += data.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf


def drain(fd, seconds, buf=""):
    """Read whatever arrives for `seconds` (a render settle that keeps the
    stream flowing instead of a blind sleep). Returns the accumulated buffer."""
    _, buf = read_until(fd, lambda _b: False, seconds, buf)
    return buf


def wait_for(predicate, timeout, interval=0.05):
    """Poll `predicate()` until true or timeout. Returns the final verdict."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


# --- deterministic OpenAI-compatible stub server ------------------------------


def sse(obj):
    return f"data: {json.dumps(obj)}\n\n".encode()


def content_chunks(text):
    yield sse({"choices": [{"index": 0, "delta": {"content": text}}]})


def toolcall_chunks(name, args):
    yield sse(
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


def make_handler(decide, model=DEFAULT_MODEL):
    """Build a BaseHTTPRequestHandler serving /models + streaming chat.

    `decide(messages)` yields SSE chunks (see content_chunks/toolcall_chunks) —
    it is the entire scenario logic; everything else is protocol boilerplate.
    """

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
                                "id": model,
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
            for chunk in decide(messages):
                self.wfile.write(chunk)
            self.wfile.write(
                sse(
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

    return Handler


def start_stub_server(decide=None, model=DEFAULT_MODEL):
    """Start the stub model server. Default `decide` streams a bare "ok"
    (enough to boot the REPL offline). Returns (server, port)."""
    if decide is None:
        decide = lambda _messages: content_chunks("ok")  # noqa: E731
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(decide, model))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


# --- PTY process management ---------------------------------------------------


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def spawn_pty(argv, env=None, rows=40, cols=120, cwd=None):
    """Fork `argv` into a real pty. Returns (pid, master).

    `env` entries overlay os.environ in the child; `cwd` chdirs the child.
    """
    pid, master = pty.fork()
    if pid == 0:  # child
        if cwd is not None:
            os.chdir(cwd)
        child_env = dict(os.environ)
        child_env.update(env or {})
        os.execvpe(argv[0], argv, child_env)
        os._exit(127)
    set_winsize(master, rows, cols)
    return pid, master


def spawn_tsforge(port, extra_env=None, rows=40, cols=120, cwd=None,
                  home=None, model=DEFAULT_MODEL, args=("--no-gate",)):
    """Spawn the real tsforge CLI pointed at the stub server."""
    env = {
        "TSFORGE_BASE_URL": f"http://127.0.0.1:{port}/v1",
        "TSFORGE_MODEL": model,
        "NO_UPDATE_NOTIFIER": "1",
    }
    if home is not None:
        env["TSFORGE_HOME"] = home
    env.update(extra_env or {})
    return spawn_pty(["bun", CLI, *args], env=env, rows=rows, cols=cols, cwd=cwd)


def alive(pid):
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return False


def reap(pid, master, exit_cmd=b"/exit\r"):
    """Ask the process to exit politely, then make sure it is gone."""
    if exit_cmd:
        try:
            os.write(master, exit_cmd)
        except OSError:
            pass
        wait_for(lambda: not alive(pid), 0.5)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass


# --- headless ANSI screen (pane / CUP paints) ---------------------------------


class VirtualScreen:
    """Minimal VT grid for e2e assertions on *visible* pane output.

    Pane paints accumulate many CUP+row writes; counting markers in the raw
    byte stream overcounts. Feed the stream here and assert on ``text()``.
    """

    def __init__(self, rows=40, cols=120):
        self.rows = rows
        self.cols = cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = 0
        self.col = 0

    def feed(self, data):
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch != "\x1b":
                self._plain(ch)
                i += 1
                continue
            if i + 1 >= n:
                break
            nxt = data[i + 1]
            if nxt == "]":  # OSC … BEL / ST
                end = data.find("\x07", i + 2)
                st = data.find("\x1b\\", i + 2)
                cut = n
                if end != -1:
                    cut = min(cut, end + 1)
                if st != -1:
                    cut = min(cut, st + 2)
                i = cut if cut < n else n
                continue
            if nxt != "[":
                i += 2
                continue
            j = i + 2
            while j < n and data[j] in "0123456789;?":
                j += 1
            if j >= n:
                break
            params = data[i + 2 : j]
            cmd = data[j]
            self._csi(params, cmd)
            i = j + 1

    def _csi(self, params, cmd):
        parts = [p for p in params.replace("?", "").split(";") if p != ""]
        nums = [int(p) for p in parts if p.isdigit()]
        if cmd in ("H", "f"):
            r = (nums[0] if len(nums) > 0 else 1) - 1
            c = (nums[1] if len(nums) > 1 else 1) - 1
            self.row = max(0, min(self.rows - 1, r))
            self.col = max(0, min(self.cols - 1, c))
        elif cmd == "J":
            mode = nums[0] if nums else 0
            if mode == 2:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self.row = 0
                self.col = 0
            elif mode == 0:
                self._clear_to_eos()
            elif mode == 1:
                self._clear_from_bos()
        elif cmd == "K":
            mode = nums[0] if nums else 0
            if mode == 2:
                self.grid[self.row] = [" "] * self.cols
            elif mode == 1:
                for c in range(0, self.col + 1):
                    self.grid[self.row][c] = " "
            else:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = " "
        # SGR / private modes / sync / cursor show-hide: ignore

    def _clear_to_eos(self):
        for c in range(self.col, self.cols):
            self.grid[self.row][c] = " "
        for r in range(self.row + 1, self.rows):
            self.grid[r] = [" "] * self.cols

    def _clear_from_bos(self):
        for r in range(0, self.row):
            self.grid[r] = [" "] * self.cols
        for c in range(0, self.col + 1):
            self.grid[self.row][c] = " "

    def _plain(self, ch):
        if ch == "\r":
            self.col = 0
            return
        if ch == "\n":
            self.row = min(self.rows - 1, self.row + 1)
            self.col = 0
            return
        if ch == "\x08":
            self.col = max(0, self.col - 1)
            return
        if ord(ch) < 32:
            return
        if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
            self.grid[self.row][self.col] = ch
        self.col += 1
        if self.col >= self.cols:
            self.col = 0
            self.row = min(self.rows - 1, self.row + 1)

    def text(self):
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines)


def visible_text(buf, rows=40, cols=120):
    """Apply ``buf`` onto a VirtualScreen and return the visible text."""
    screen = VirtualScreen(rows, cols)
    screen.feed(buf)
    return screen.text()


# --- pass/fail tally ----------------------------------------------------------


class Checker:
    """Collects named assertions and prints the suite verdict."""

    def __init__(self):
        self.results = []

    def check(self, name, cond, detail=""):
        self.results.append((name, bool(cond)))
        suffix = f"  — {detail}" if detail and not cond else ""
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}{suffix}")
        return bool(cond)

    @property
    def ok(self):
        return all(c for _, c in self.results)

    def finish(self):
        """Print the summary line and return the process exit code."""
        npass = sum(1 for _, c in self.results if c)
        total = len(self.results)
        verdict = "ALL PASS" if npass == total else "FAILURES"
        print(f"\n==== {npass}/{total} — {verdict} ====")
        return 0 if npass == total else 1
