#!/usr/bin/env python3
"""Drive the REAL tsforge /help capability browser in a pty under the pane console
and assert the overlay renders and runs commands:
  1. /help opens (title + footer visible in the byte stream).
  2. Selection styling still uses brand+bold after scroll.
  3. Selecting a command runs it (no // double-slash regression).

Uses readline input (TSFORGE_BASIC_INPUT) so `/help` submits as a slash command
without the editor's `/` palette intercept. Stub model keeps boot offline."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    alive,
    drain,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    wait_for,
)

# The selected-row style: brand truecolor THEN bold (see render/inline-menu formatRow).
BRAND_BOLD = "\x1b[38;2;59;130;246m\x1b[1m"


def main():
    t = Checker()
    srv, port = start_stub_server()
    home = tempfile.mkdtemp(prefix="tsforge-help-")
    pid, m = spawn_tsforge(
        port, {"TSFORGE_BASIC_INPUT": "1"}, home=home, rows=24, cols=100
    )

    got, buf = read_until(
        m, lambda b: " PLAN " in b or "> " in b or "TSFORGE" in b, 40
    )
    t.check("REPL boots", got)

    os.write(m, b"/help\r")
    got, buf = read_until(
        m,
        lambda b: "what can I do?" in b or "esc close" in b,
        12,
        buf,
    )
    t.check("/help opens the capability browser", got)
    t.check("title pinned in overlay", "what can I do?" in buf)

    for _ in range(4):
        os.write(m, b"\x1b[B")
        buf = drain(m, 0.25, buf)
    buf = drain(m, 1.0, buf)

    t.check("footer stays visible after scroll", "esc close" in buf)
    t.check(
        "selected row uses brand+bold styling",
        buf.count(BRAND_BOLD) >= 1,
    )

    os.write(m, b"\x1b")  # close /help
    died = wait_for(lambda: not alive(pid), 0.8)
    t.check("tsforge STILL RUNNING after /help closes", not died)

    os.write(m, b"/help\r")
    read_until(m, lambda b: "esc close" in b, 8)
    os.write(m, b"\x1b[B")
    drain(m, 0.25)
    os.write(m, b"\x1b[B")
    drain(m, 0.25)
    os.write(m, b"\r")  # select /plan
    ran, selbuf = read_until(m, lambda b: " NORMAL " in b, 8)
    t.check(
        "selecting a /help command RUNS it (no //, mode → normal)",
        ran and "unknown command" not in selbuf,
    )

    reap(pid, m, exit_cmd=b"")
    srv.shutdown()
    sys.exit(t.finish())


if __name__ == "__main__":
    main()
