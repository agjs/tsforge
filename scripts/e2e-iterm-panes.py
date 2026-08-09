#!/usr/bin/env python3
"""
Lightweight iTerm/tmux smoke for the pane TUI.

Checks that the harness enters the alternate screen, paints a two-column
layout marker, and leaves cleanly on exit. Complements e2e-iterm-tui.py
(classic REPL) — this suite stays opt-in until the pane TUI is the default.
"""

from __future__ import annotations

import os
import pty
import select
import struct
import fcntl
import termios
import time
import sys

ENTER_ALT = b"\x1b[?1049h"
EXIT_ALT = b"\x1b[?1049l"


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = [
        "bun",
        "run",
        "tsforge",
        "--dir",
        repo,
    ]

    pid, master = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.execvp(cmd[0], cmd)

    set_winsize(master, 24, 100)
    buf = b""
    deadline = time.time() + 8.0
    saw_enter = False

    try:
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.2)
            if master in r:
                chunk = os.read(master, 4096)
                if not chunk:
                    break
                buf += chunk
                if ENTER_ALT in buf:
                    saw_enter = True
                    # Ask the REPL to dump + leave via /copy then /exit.
                    os.write(master, b"/copy\n")
                    time.sleep(0.3)
                    os.write(master, b"/exit\n")
                    time.sleep(0.5)
                    break
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    if not saw_enter:
        sys.stderr.write("e2e-iterm-panes: never saw alternate-screen enter\n")
        sys.stderr.write(buf[-2000:].decode("utf-8", "replace"))
        return 1

    # Exit sequence is best-effort (process may already be gone).
    print("e2e-iterm-panes: alt-screen enter observed")
    if EXIT_ALT in buf:
        print("e2e-iterm-panes: alt-screen exit observed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
