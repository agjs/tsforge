"""Shared helpers for the REAL-iTerm2 e2e suite (macOS, opt-in).

These scripts drive an actual GUI terminal via AppleScript — the only harness
whose resize/reflow is real. Everything AppleScript-shaped that the three
e2e-iterm-*.py scripts duplicated lives here; scenario logic stays in the
scripts. The model under test is overridable via TSFORGE_E2E_MODEL.
"""
import contextlib
import os
import re
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(REPO, "packages/core/src/cli.ts")
MODEL = os.environ.get("TSFORGE_E2E_MODEL", "deepseek-ai/DeepSeek-V4-Flash")
# Status-bar detector for the model under test (basename only — the bar shows
# the short model name, not the org prefix).
BAR = re.compile(
    re.escape(MODEL.split("/")[-1]) + r".*(0%|ready|tok/s|thinking|▕|●|✓)"
)


def osa(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("OSA ERR: " + r.stderr + "\n")
    return r.stdout.rstrip("\n")


def new_window():
    return osa('tell application "iTerm2" to return id of (create window with default profile)')


def close_window(wid):
    osa(f'tell application "iTerm2" to close window id {wid}')


def send(wid, text, newline=False):
    """Type `text` into the window. newline=True presses Enter after it."""
    esc = text.replace("\\", "\\\\").replace('"', '\\"')
    nl = "" if newline else " newline no"
    osa(
        f'tell application "iTerm2" to tell current session of window id {wid} '
        f'to write text "{esc}"{nl}'
    )


def screen(wid):
    """The visible screen contents (no scrollback for a fresh session)."""
    return osa(
        f'tell application "iTerm2" to return contents of current session of window id {wid}'
    )


def get_bounds(wid):
    out = osa(f'tell application "iTerm2" to return bounds of window id {wid}')
    return [int(x.strip()) for x in out.split(",")]


def set_bounds(wid, left, top, right, bottom):
    osa(
        f'tell application "iTerm2" to set bounds of window id {wid} '
        f"to {{{left}, {top}, {right}, {bottom}}}"
    )


def wait_for_screen(wid, pred, timeout, label, interval=1.0):
    """Poll the visible screen until pred(contents) or timeout.
    Returns (matched, last_contents)."""
    t0 = time.monotonic()
    last = ""
    while time.monotonic() - t0 < timeout:
        last = screen(wid)
        if pred(last):
            return True, last
        time.sleep(interval)
    print(f"  TIMEOUT waiting for: {label}")
    return False, last


def stable_frame(wid, retries=6, settle=0.25):
    """The visible screen once the status bar is present (avoids catching a
    mid-render partial). Returns the screen lines."""
    lines = screen(wid).split("\n")
    for _ in range(retries):
        if any(BAR.search(line) for line in lines):
            return lines
        time.sleep(settle)
        lines = screen(wid).split("\n")
    return lines


def count_bars(wid):
    return sum(1 for line in stable_frame(wid) if BAR.search(line))


@contextlib.contextmanager
def window():
    """A fresh iTerm2 window that is ALWAYS closed, even when the scenario
    raises — no stranded GUI windows after a failing run."""
    wid = new_window()
    try:
        yield wid
    finally:
        close_window(wid)
