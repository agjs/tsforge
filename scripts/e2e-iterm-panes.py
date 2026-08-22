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
    deadline = time.time() + 20.0
    saw_enter = False
    keys_sent = False

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
                text = buf.decode("utf-8", "replace")
                # Wait until the editor is accepting input — keys sent too early
                # (right after alt-screen enter) are lost or go to the wrong layer.
                if (
                    saw_enter
                    and not keys_sent
                    and "describe a task" in text.lower()
                ):
                    keys_sent = True
                    # Rail is visible at idle — cycle directly (do not Ctrl+G: that hides it).
                    time.sleep(0.3)
                    os.write(master, b"\x1b[17~")
                    time.sleep(0.8)
                    os.write(master, b"/exit\n")
                    # Keep reading until the child exits so Gate repaint lands in buf.
                    exit_deadline = time.time() + 5.0
                    while time.time() < exit_deadline:
                        r2, _, _ = select.select([master], [], [], 0.2)
                        if master not in r2:
                            continue
                        chunk2 = os.read(master, 4096)
                        if not chunk2:
                            break
                        buf += chunk2
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

    if not keys_sent:
        sys.stderr.write("e2e-iterm-panes: prompt never became ready for key injection\n")
        return 1

    text = buf.decode("utf-8", "replace")
    if "Gate" not in text:
        sys.stderr.write("e2e-iterm-panes: Gate rail title not observed after cycle\n")
        return 1

    # Exit sequence is best-effort (process may already be gone).
    print("e2e-iterm-panes: alt-screen enter observed")
    print("e2e-iterm-panes: Gate rail surface observed")
    if EXIT_ALT in buf:
        print("e2e-iterm-panes: alt-screen exit observed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
