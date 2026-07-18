#!/usr/bin/env python3
"""Drive the REAL tsforge /help capability browser in a pty on a SHORT terminal and
assert the inline menu renders correctly:
  1. No frame stacking (the region is bounded to the terminal height, so the status
     bar's relative-redraw can fully clear it — a taller region stacked on scroll).
  2. Only the SELECTED row is blue+bold; every other row is plain default text
     (a prior bug painted them all bold, then all blue/barely-visible).
  3. Title at the top, the selected row's description at the bottom.

Uses the shared deterministic model stub so boot succeeds offline."""
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
    # SHORT terminal (14 rows): the inline menu MUST bound its height so the whole
    # region fits — otherwise the status bar can't clear it and frames stack.
    pid, m = spawn_tsforge(port, home=home, rows=14, cols=100)

    got, _ = read_until(m, lambda b: "plan mode" in b or "› " in b, 40)
    t.check("REPL boots", got)

    # Open /help via the palette (the inline palette titles itself "commands").
    os.write(m, b"/")
    read_until(m, lambda b: "commands" in b, 10)
    os.write(m, b"help\r")
    got, _ = read_until(m, lambda b: "what can I do?" in b, 8)
    t.check("/help opens the capability browser (title renders)", got)

    # Scroll down several times, accumulating every redraw, then keep only the
    # LAST frame (content after the final erase-to-end). The buffer must be
    # threaded through the drains — a discarding drain would eat the redraw
    # bytes the frame assertion needs.
    tail = ""
    for _ in range(4):
        os.write(m, b"\x1b[B")
        tail = drain(m, 0.25, tail)  # settle each scroll redraw (no unique marker per row)
    tail = drain(m, 1.2, tail)
    frame = tail.split("\x1b[0J")[-1]  # content after the last full erase-to-end

    t.check("no frame stacking (footer appears exactly once)", frame.count("esc close") == 1)
    t.check("title stays at the top of the frame", "what can I do?" in frame)
    t.check(
        "only the selected row is blue+bold (exactly one styled row)",
        frame.count(BRAND_BOLD) == 1,
    )
    if frame.count(BRAND_BOLD) != 1 or frame.count("esc close") != 1:
        print("      DEBUG frame tail:", repr(frame[-500:]))

    os.write(m, b"\x1b")  # close /help
    died = wait_for(lambda: not alive(pid), 0.8)
    t.check("tsforge STILL RUNNING after /help closes", not died)

    # Selecting a command must actually RUN it (regression: runCommand prepended a
    # slash to the already-slashed name → "//sessions" → unknown command). Reopen
    # /help, pick /plan (rows 0=/compact 1=/clear 2=/plan; /scaffold's home is the
    # wizard row under "Build something new", not a command row), confirm it toggled
    # mode.
    os.write(m, b"/")
    read_until(m, lambda b: "commands" in b, 8)
    os.write(m, b"help\r")
    read_until(m, lambda b: "what can I do?" in b, 8)
    os.write(m, b"\x1b[B")
    drain(m, 0.25)  # settle the selection redraw
    os.write(m, b"\x1b[B")
    drain(m, 0.25)  # settle the selection redraw
    os.write(m, b"\r")  # select /plan
    ran, selbuf = read_until(m, lambda b: "normal" in b, 6)
    t.check(
        "selecting a /help command RUNS it (no //, mode → normal)",
        ran and "unknown command" not in selbuf,
    )

    reap(pid, m, exit_cmd=b"")
    srv.shutdown()
    sys.exit(t.finish())


if __name__ == "__main__":
    main()
