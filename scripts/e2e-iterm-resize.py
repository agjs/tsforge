#!/usr/bin/env python3
"""Opt-in e2e: drive the REAL iTerm2 (AppleScript), run tsforge, start a turn, do a
circular corner-resize, read the terminal buffer, and count status-bar copies.

This is the only harness that exercises the actual terminal + its resize reflow —
VirtualScreen (bun tests) can't reflow. Use it to sanity-check the status bar
against a real drag.

Requirements: macOS + iTerm2 running + a reachable model endpoint (it sends a
prompt to elicit a streaming turn). Run: `python3 scripts/e2e-iterm-resize.py`.

CAVEAT: reproduction is TIMING-DEPENDENT — the scrollback-pollution bug only
surfaces when the model is actively streaming DURING the drag, and osascript
resizes (~70ms/step) are far slower than a real mouse drag. So a clean run here is
necessary-not-sufficient; a real hand-drag is the final check. The relative-redraw
StatusBar is correct by construction (no scroll region ⇒ the bar is never left in
the scrollable buffer to trail), which is what this guards against regressing."""
import subprocess, time, math, sys, re, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def osa(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("OSA ERR: " + r.stderr + "\n")
    return r.stdout.rstrip("\n")

def create_window():
    return osa('tell application "iTerm2" to return id of (create window with default profile)')

def write_text(wid, text, newline=True):
    esc = text.replace("\\", "\\\\").replace('"', '\\"')
    nl = "" if newline else " newline no"
    osa(f'tell application "iTerm2" to tell current session of window id {wid} to write text "{esc}"{nl}')

def get_bounds(wid):
    out = osa(f'tell application "iTerm2" to return bounds of window id {wid}')
    return [int(x.strip()) for x in out.split(",")]

def set_bounds(wid, l, t, r, b):
    osa(f'tell application "iTerm2" to set bounds of window id {wid} to {{{l}, {t}, {r}, {b}}}')

def contents(wid):
    return osa(f'tell application "iTerm2" to return contents of current session of window id {wid}')

def visible_rows(wid):
    return int(osa(f'tell application "iTerm2" to return number of rows of current session of window id {wid}') or "24")

BAR = re.compile(r"DeepSeek-V4-Flash.*(0%|ready|tok/s|thinking|▕|●|✓)")

def count_bars(wid):
    """FULL buffer (scrollback + visible): scrollback-stranded bars are the real
    bug the user sees when scrolling up, so count every bar line in the buffer."""
    text = contents(wid)
    hits = [ln for ln in text.split("\n") if BAR.search(ln)]
    return len(hits), hits

def main():
    wid = create_window()
    print("window id:", wid)
    write_text(wid, f"cd {REPO} && bun run tsforge")
    time.sleep(8.0)  # boot

    n, lines = count_bars(wid)
    print(f"after boot: bars={n}")
    for l in lines: print("   ", l.strip()[:70])

    # start a turn so the spinner ticks during the drag
    write_text(wid, "List 40 common HTTP status codes with one-line descriptions.")
    time.sleep(1.2)

    l0, t0, r0, b0 = get_bounds(wid)
    print("base bounds:", l0, t0, r0, b0)
    cx = l0 + 620; cy = t0 + 430          # center of the bottom-right corner circle
    rw = 260; rh = 210                    # radius

    maxbars = 0; maxlines = []; maxat = ""
    steps = 60; loops = 3
    for i in range(steps):
        th = (i / steps) * loops * 2 * math.pi
        r = int(cx + rw * math.cos(th))
        b = int(cy + rh * math.sin(th))
        set_bounds(wid, l0, t0, max(l0 + 300, r), max(t0 + 200, b))
        if i % 3 == 0:
            n, lines = count_bars(wid)
            if n > maxbars:
                maxbars = n; maxlines = lines; maxat = f"step {i} size~{r-l0}x{b-t0}"

    time.sleep(0.8)
    fn, flines = count_bars(wid)
    final_full = contents(wid)

    osa(f'tell application "iTerm2" to close window id {wid}')

    print(f"\nMAX status bars during drag: {maxbars}  ({maxat})")
    for l in maxlines: print("   ", l.strip()[:70])
    print(f"\nFINAL bars in view: {fn}")
    print("=== FINAL VISIBLE SCREEN ===")
    print(final_full)

if __name__ == "__main__":
    main()
