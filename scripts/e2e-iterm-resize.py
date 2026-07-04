#!/usr/bin/env python3
"""Opt-in e2e: drive the REAL iTerm2 (AppleScript), run tsforge, start a turn, do a
circular corner-resize, read the terminal buffer, and count status-bar copies.

This is the only harness that exercises the actual terminal + its resize reflow —
VirtualScreen (bun tests) can't reflow. Use it to sanity-check the status bar
against a real drag.

Requirements: macOS + iTerm2 running + a reachable model endpoint (it sends a
prompt to elicit a streaming turn). Model overridable via TSFORGE_E2E_MODEL.
Run: `python3 scripts/e2e-iterm-resize.py`.

CAVEAT: reproduction is TIMING-DEPENDENT — the scrollback-pollution bug only
surfaces when the model is actively streaming DURING the drag, and osascript
resizes (~70ms/step) are far slower than a real mouse drag. So a clean run here is
necessary-not-sufficient; a real hand-drag is the final check. The relative-redraw
StatusBar is correct by construction (no scroll region ⇒ the bar is never left in
the scrollable buffer to trail), which is what this guards against regressing."""
import math
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from itermharness import (  # noqa: E402
    BAR,
    REPO,
    get_bounds,
    screen,
    send,
    set_bounds,
    window,
)


def count_bars(wid):
    """FULL buffer (scrollback + visible): scrollback-stranded bars are the real
    bug the user sees when scrolling up, so count every bar line in the buffer."""
    text = screen(wid)
    hits = [ln for ln in text.split("\n") if BAR.search(ln)]
    return len(hits), hits


def main():
    with window() as wid:
        print("window id:", wid)
        send(wid, f"cd {REPO} && bun run tsforge", newline=True)
        time.sleep(8.0)  # boot

        n, lines = count_bars(wid)
        print(f"after boot: bars={n}")
        for l in lines:
            print("   ", l.strip()[:70])

        # start a turn so the spinner ticks during the drag
        send(wid, "List 40 common HTTP status codes with one-line descriptions.", newline=True)
        time.sleep(1.2)

        l0, t0, r0, b0 = get_bounds(wid)
        print("base bounds:", l0, t0, r0, b0)
        cx = l0 + 620
        cy = t0 + 430  # center of the bottom-right corner circle
        rw = 260
        rh = 210  # radius

        maxbars = 0
        maxlines = []
        maxat = ""
        steps = 60
        loops = 3
        for i in range(steps):
            th = (i / steps) * loops * 2 * math.pi
            r = int(cx + rw * math.cos(th))
            b = int(cy + rh * math.sin(th))
            set_bounds(wid, l0, t0, max(l0 + 300, r), max(t0 + 200, b))
            if i % 3 == 0:
                n, lines = count_bars(wid)
                if n > maxbars:
                    maxbars = n
                    maxlines = lines
                    maxat = f"step {i} size~{r - l0}x{b - t0}"

        time.sleep(0.8)
        fn, flines = count_bars(wid)
        final_full = screen(wid)

    print(f"\nMAX status bars during drag: {maxbars}  ({maxat})")
    for l in maxlines:
        print("   ", l.strip()[:70])
    print(f"\nFINAL bars in view: {fn}")
    print("=== FINAL VISIBLE SCREEN ===")
    print(final_full)


if __name__ == "__main__":
    main()
