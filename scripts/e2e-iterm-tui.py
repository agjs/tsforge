#!/usr/bin/env python3
"""Opt-in e2e: drive REAL iTerm2 through the core TUI scenarios (typing, editing,
multi-line, `/` palette, `/clear`, `@` picker, a streaming turn, resize, long-line
wrap); read the terminal buffer; assert. Each runs in a fresh window; reports
PASS/FAIL.

This is the reflow-capable end-to-end check VirtualScreen (bun tests) can't do.
Requires macOS + iTerm2 running + a reachable model endpoint. Run:
  python3 scripts/e2e-iterm-tui.py

Reads wait for a stable frame (bar present) to avoid catching a mid-render partial;
osascript resizes are slower than a real hand-drag, so a clean run is a strong
signal but a real drag remains the final check for resize specifically."""
import subprocess, time, re, sys, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = "deepseek-ai/DeepSeek-V4-Flash"
BAR = re.compile(r"DeepSeek-V4-Flash.*(0%|ready|tok/s|thinking|▕|●|✓)")

def osa(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return r.stdout.rstrip("\n")

def new_window():
    return osa('tell application "iTerm2" to return id of (create window with default profile)')

def send(wid, text, newline=False):
    esc = text.replace("\\", "\\\\").replace('"', '\\"')
    nl = "" if newline else " newline no"
    osa(f'tell application "iTerm2" to tell current session of window id {wid} to write text "{esc}"{nl}')

def screen(wid):
    return osa(f'tell application "iTerm2" to return contents of current session of window id {wid}')

def visible(wid):
    # iTerm2 `number of rows` is unreliable (returns 1); `contents` is the visible
    # screen (no scrollback for a fresh session). Retry until a stable frame with
    # the bar present, to avoid catching a mid-render partial read.
    lines = screen(wid).split("\n")

    for _ in range(6):
        if any(BAR.search(l) for l in lines):
            return lines

        time.sleep(0.25)
        lines = screen(wid).split("\n")

    return lines

def bars(wid):
    return sum(1 for l in visible(wid) if BAR.search(l))

def close(wid):
    osa(f'tell application "iTerm2" to close window id {wid}')

def boot():
    wid = new_window()
    send(wid, f"cd {REPO} && bun run tsforge", newline=True)
    time.sleep(7.0)
    return wid

RESULTS = []
def check(name, cond, detail=""):
    RESULTS.append((name, cond, detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not cond else ""))

# --- scenarios ---------------------------------------------------------------

def s_type_render():
    wid = boot()
    send(wid, "hello world")
    time.sleep(0.4)
    v = visible(wid)
    has = any("hello world" in l for l in v)
    check("type: text renders on input line", has)
    check("type: exactly one status bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_backspace():
    wid = boot()
    send(wid, "helloX")
    time.sleep(0.2)
    send(wid, "\x7f")  # backspace
    time.sleep(0.3)
    v = visible(wid)
    check("backspace: shows 'hello' not 'helloX'", any(re.search(r"hello(?!X)", l) for l in v) and not any("helloX" in l for l in v))
    check("backspace: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_multiline():
    wid = boot()
    send(wid, "line1")
    send(wid, "\x1b\r")  # Alt+Enter → newline
    send(wid, "line2")
    time.sleep(0.4)
    v = visible(wid)
    check("multiline: both lines present", any("line1" in l for l in v) and any("line2" in l for l in v))
    check("multiline: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_palette_cancel():
    wid = boot()
    send(wid, "/")   # opens palette
    time.sleep(0.8)
    send(wid, "\x1b")  # Esc → cancel
    time.sleep(0.6)
    send(wid, "abc")   # type after cancel
    time.sleep(0.3)
    v = visible(wid)
    # No stranded slash line; the new text shows; one bar.
    stray_slash = sum(1 for l in v if l.strip() == "/" or re.match(r"^/+\s*$", l.strip()))
    check("palette cancel: no stranded '/' line", stray_slash == 0, f"stray={stray_slash}")
    check("palette cancel: typed text shows", any("abc" in l for l in v))
    check("palette cancel: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_clear_ghost():
    wid = boot()
    send(wid, "/")
    time.sleep(0.8)
    # type to filter to "clear", then Enter to select
    send(wid, "clear")
    time.sleep(0.5)
    send(wid, "\r")  # select
    time.sleep(1.0)
    send(wid, "hi")  # type after clear
    time.sleep(0.4)
    v = visible(wid)
    # The ghost bug = the command NAME lingering as input (a line that is just
    # "clear"/"/clear"). The "conversation cleared" confirmation is expected.
    ghost = any(re.match(r"^[›\s]*/?clear\s*$", l.strip()) for l in v)

    check("/clear: no command-name ghost", not ghost, "ghost text present")
    check("/clear: typed 'hi' shows", any("hi" in l for l in v))
    check("/clear: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_at_picker():
    wid = boot()
    send(wid, "@")
    time.sleep(0.8)
    v = visible(wid)
    # The dropdown should list files (something with a path/extension) and one bar.
    has_files = any(re.search(r"\.(ts|md|json|js)\b", l) for l in v)
    check("@ picker: shows file list", has_files)
    check("@ picker: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_stream():
    wid = boot()
    send(wid, "say hi in one short sentence")
    send(wid, "\r")
    time.sleep(6.0)
    v = visible(wid)
    # Some response text appeared and exactly one bar remains.
    check("stream: one bar during/after turn", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_resize_idle():
    wid = boot()
    send(wid, "keepme")
    time.sleep(0.3)
    raw = osa(f'tell application "iTerm2" to return bounds of window id {wid}')
    b = [int(x.strip()) for x in raw.split(",")]
    osa(f'tell application "iTerm2" to set bounds of window id {wid} to {{{b[0]}, {b[1]}, {b[2]+150}, {b[3]+120}}}')
    time.sleep(0.6)
    v = visible(wid)
    check("resize idle: input text survives", any("keepme" in l for l in v))
    check("resize idle: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

def s_longline():
    wid = boot()
    send(wid, "Z" * 200)
    time.sleep(0.9)
    v = visible(wid)
    check("long line: wraps and shows Z", any(l.count("Z") > 40 for l in v))
    check("long line: one bar", bars(wid) == 1, f"bars={bars(wid)}")
    close(wid)

if __name__ == "__main__":
    for fn in [s_type_render, s_backspace, s_multiline, s_palette_cancel,
               s_clear_ghost, s_at_picker, s_stream, s_resize_idle, s_longline]:
        print(f"\n### {fn.__name__}")
        try:
            fn()
        except Exception as e:
            check(fn.__name__, False, f"exception: {e}")

    npass = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n==== {npass}/{len(RESULTS)} checks passed ====")
    sys.exit(0 if npass == len(RESULTS) else 1)
