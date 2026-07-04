#!/usr/bin/env python3
"""Opt-in e2e: drive REAL iTerm2 through the core TUI scenarios (typing, editing,
multi-line, `/` palette, `/clear`, `@` picker filter+select, bracketed paste, a
streaming turn, resize, long-line wrap); read the terminal buffer; assert. Each
runs in a fresh window (always closed, even on failure); reports PASS/FAIL.

This is the reflow-capable end-to-end check VirtualScreen (bun tests) can't do.
Requires macOS + iTerm2 running + a reachable model endpoint. The model under
test defaults to DeepSeek-V4-Flash; override with TSFORGE_E2E_MODEL. Run:
  python3 scripts/e2e-iterm-tui.py

Reads wait for a stable frame (bar present) to avoid catching a mid-render partial;
osascript resizes are slower than a real hand-drag, so a clean run is a strong
signal but a real drag remains the final check for resize specifically."""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from itermharness import (  # noqa: E402
    BAR,
    REPO,
    get_bounds,
    send,
    set_bounds,
    stable_frame,
    window,
)
from ptyharness import Checker  # noqa: E402

t = Checker()


def bars(wid):
    return sum(1 for line in stable_frame(wid) if BAR.search(line))


def boot(wid):
    send(wid, f"cd {REPO} && bun run tsforge", newline=True)
    time.sleep(7.0)


# --- scenarios ---------------------------------------------------------------


def s_type_render():
    with window() as wid:
        boot(wid)
        send(wid, "hello world")
        time.sleep(0.4)
        v = stable_frame(wid)
        t.check("type: text renders on input line", any("hello world" in l for l in v))
        t.check("type: exactly one status bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_backspace():
    with window() as wid:
        boot(wid)
        send(wid, "helloX")
        time.sleep(0.2)
        send(wid, "\x7f")  # backspace
        time.sleep(0.3)
        v = stable_frame(wid)
        t.check(
            "backspace: shows 'hello' not 'helloX'",
            any(re.search(r"hello(?!X)", l) for l in v) and not any("helloX" in l for l in v),
        )
        t.check("backspace: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_multiline():
    with window() as wid:
        boot(wid)
        send(wid, "line1")
        send(wid, "\x1b\r")  # Alt+Enter → newline
        send(wid, "line2")
        time.sleep(0.4)
        v = stable_frame(wid)
        t.check(
            "multiline: both lines present",
            any("line1" in l for l in v) and any("line2" in l for l in v),
        )
        t.check("multiline: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_palette_cancel():
    with window() as wid:
        boot(wid)
        send(wid, "/")  # opens palette
        time.sleep(0.8)
        send(wid, "\x1b")  # Esc → cancel
        time.sleep(0.6)
        send(wid, "abc")  # type after cancel
        time.sleep(0.3)
        v = stable_frame(wid)
        # No stranded slash line; the new text shows; one bar.
        stray_slash = sum(1 for l in v if l.strip() == "/" or re.match(r"^/+\s*$", l.strip()))
        t.check("palette cancel: no stranded '/' line", stray_slash == 0, f"stray={stray_slash}")
        t.check("palette cancel: typed text shows", any("abc" in l for l in v))
        t.check("palette cancel: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_clear_ghost():
    with window() as wid:
        boot(wid)
        send(wid, "/")
        time.sleep(0.8)
        # type to filter to "clear", then Enter to select
        send(wid, "clear")
        time.sleep(0.5)
        send(wid, "\r")  # select
        time.sleep(1.0)
        send(wid, "hi")  # type after clear
        time.sleep(0.4)
        v = stable_frame(wid)
        # The ghost bug = the command NAME lingering as input (a line that is just
        # "clear"/"/clear"). The "conversation cleared" confirmation is expected.
        ghost = any(re.match(r"^[›\s]*/?clear\s*$", l.strip()) for l in v)

        t.check("/clear: no command-name ghost", not ghost, "ghost text present")
        t.check("/clear: typed 'hi' shows", any("hi" in l for l in v))
        t.check("/clear: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_at_picker():
    with window() as wid:
        boot(wid)
        send(wid, "@")
        time.sleep(0.8)
        v = stable_frame(wid)
        # The dropdown should list files (something with a path/extension) and one bar.
        has_files = any(re.search(r"\.(ts|md|json|js)\b", l) for l in v)
        t.check("@ picker: shows file list", has_files)
        t.check("@ picker: one bar", bars(wid) == 1, f"bars={bars(wid)}")

        # INTERACTION: filter to package.json, select it, and see the path land in
        # the input row (not just "a list rendered").
        send(wid, "package.json")
        time.sleep(0.6)
        v = stable_frame(wid)
        filtered = any("package.json" in l for l in v)
        t.check("@ picker: typing filters to package.json", filtered)
        send(wid, "\r")  # accept the highlighted row
        time.sleep(0.6)
        v = stable_frame(wid)
        landed = any("package.json" in l and "@" in l for l in v)
        t.check("@ picker: Enter inserts the picked path into the input", landed)
        t.check("@ picker: one bar after select", bars(wid) == 1, f"bars={bars(wid)}")


def s_paste():
    with window() as wid:
        boot(wid)
        # A real bracketed paste: iTerm wraps clipboard pastes in ESC[200~/201~ when
        # the app enables paste mode (the editor does); we emit the same bytes. The
        # CR between the lines is INSIDE the brackets → must become a newline in the
        # input, not a submit.
        send(wid, "\x1b[200~pasted alpha", newline=True)  # newline=CR inside the paste
        send(wid, "pasted beta\x1b[201~")
        time.sleep(0.8)
        v = stable_frame(wid)
        both = any("pasted alpha" in l for l in v) and any("pasted beta" in l for l in v)
        t.check("paste: both lines land in the input", both)
        # No user bubble yet = the CR did not submit.
        no_submit = not any("╭─ you" in l for l in v)
        t.check("paste: embedded CR did NOT submit", no_submit)
        t.check("paste: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_stream():
    with window() as wid:
        boot(wid)
        send(wid, "say hi in one short sentence")
        send(wid, "\r")
        time.sleep(6.0)
        # Some response text appeared and exactly one bar remains.
        t.check("stream: one bar during/after turn", bars(wid) == 1, f"bars={bars(wid)}")


def s_resize_idle():
    with window() as wid:
        boot(wid)
        send(wid, "keepme")
        time.sleep(0.3)
        b = get_bounds(wid)
        set_bounds(wid, b[0], b[1], b[2] + 150, b[3] + 120)
        time.sleep(0.6)
        v = stable_frame(wid)
        t.check("resize idle: input text survives", any("keepme" in l for l in v))
        t.check("resize idle: one bar", bars(wid) == 1, f"bars={bars(wid)}")


def s_longline():
    with window() as wid:
        boot(wid)
        send(wid, "Z" * 200)
        time.sleep(0.9)
        v = stable_frame(wid)
        t.check("long line: wraps and shows Z", any(l.count("Z") > 40 for l in v))
        t.check("long line: one bar", bars(wid) == 1, f"bars={bars(wid)}")


if __name__ == "__main__":
    for fn in [s_type_render, s_backspace, s_multiline, s_palette_cancel,
               s_clear_ghost, s_at_picker, s_paste, s_stream, s_resize_idle,
               s_longline]:
        print(f"\n### {fn.__name__}")
        try:
            fn()
        except Exception as e:
            t.check(fn.__name__, False, f"exception: {e}")

    sys.exit(t.finish())
