#!/usr/bin/env python3
"""e2e: drive REAL iTerm2 through the plan-first lifecycle against the REAL model.

  boot (default => plan mode)  -> confirm the PLAN banner
  ask a change that needs a WRITE
    -> confirm NO file is written and a plan / clarifying reply comes back (read-only)
  type 'approve'
    -> confirm the approval gate fires and the file is THEN written + correct

This is the high-fidelity pass: real GUI terminal (its own reflow), real streaming,
real policy layer, real model. It is macOS + iTerm2 + a reachable model endpoint
only — the CI-capable, deterministic sibling is scripts/e2e-pty.py.

Runs tsforge in a throwaway dir so nothing touches this repo. Run:
  python3 scripts/e2e-iterm-plan-mode.py
"""
import subprocess, time, os, tempfile, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO, "packages/core/src/cli.ts")


def osa(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("OSA ERR: " + r.stderr + "\n")
    return r.stdout.rstrip("\n")


def new_window():
    return osa('tell application "iTerm2" to return id of (create window with default profile)')


def send(wid, text, submit=True):
    esc = text.replace("\\", "\\\\").replace('"', '\\"')
    nl = "" if submit else " newline no"
    osa(f'tell application "iTerm2" to tell current session of window id {wid} to write text "{esc}"{nl}')


def screen(wid):
    return osa(f'tell application "iTerm2" to return contents of current session of window id {wid}')


def close(wid):
    osa(f'tell application "iTerm2" to close window id {wid}')


def wait_for(wid, pred, timeout, label):
    t0 = time.monotonic()
    last = ""
    while time.monotonic() - t0 < timeout:
        last = screen(wid)
        if pred(last):
            return True, last
        time.sleep(1.0)
    print(f"  TIMEOUT waiting for: {label}")
    return False, last


def boot(wid, work):
    """Launch tsforge and CONFIRM it came up. iTerm2's `write text` can race the
    shell's startup and drop/transpose the first keystrokes (seen: `cd`->`dcd`),
    which silently leaves you at a zsh prompt — so verify the banner and retry the
    launch line rather than trusting the first send."""
    booted = lambda s: "plan mode (default)" in s or "· PLAN" in s
    for attempt in range(3):
        time.sleep(1.5)  # let the shell + prompt settle before the first keystrokes
        send(wid, f"cd {work} && TSFORGE_NO_UPDATE_CHECK=1 bun {CLI} --no-gate")
        got, _ = wait_for(wid, booted, 30, f"PLAN banner (boot attempt {attempt + 1})")
        if got:
            return True
        # Mangled launch line: reset the shell line and try again.
        send(wid, "\x03", submit=False)  # Ctrl-C
        time.sleep(0.5)
        send(wid, "\x15", submit=False)  # Ctrl-U (clear line)
        time.sleep(0.5)
    return False


def main():
    ok = True
    work = tempfile.mkdtemp(prefix="tsforge-planmode-")
    target = os.path.join(work, "src", "sum.ts")
    wid = new_window()
    print("window:", wid, "workdir:", work)

    got = boot(wid, work)
    print(f"  [{'PASS' if got else 'FAIL'}] boots into plan mode by default")
    ok &= got
    if not got:
        print("  (tsforge never launched — aborting)")
        close(wid)
        sys.exit(1)

    send(
        wid,
        "Create a new file src/sum.ts exporting `export function sum(a: number, "
        "b: number): number` that returns a + b.",
    )

    # Post-turn checkpoint (emoji-free substring; the banner says a different thing).
    got, _ = wait_for(
        wid, lambda s: "reply to refine" in s, 120, "plan-ready checkpoint"
    )
    wrote_early = os.path.exists(target)
    print(f"  [{'PASS' if got else 'FAIL'}] proposed a plan and reached the idle checkpoint")
    print(
        f"  [{'PASS' if not wrote_early else 'FAIL'}] NO file written during plan mode "
        f"(read-only)   file_exists={wrote_early}"
    )
    ok &= got and (not wrote_early)

    time.sleep(1.5)
    send(wid, "approve")
    recog, _ = wait_for(
        wid, lambda s: "plan approved" in s.lower(), 30, "'plan approved — implementing'"
    )
    print(f"  [{'PASS' if recog else 'FAIL'}] 'approve' hit the approval gate (not steered)")
    ok &= recog

    got, _ = wait_for(wid, lambda _s: os.path.exists(target), 150, "file written after approve")
    print(
        f"  [{'PASS' if got else 'FAIL'}] file written AFTER approve (tools unlocked)   "
        f"file_exists={os.path.exists(target)}"
    )
    ok &= got
    if os.path.exists(target):
        with open(target) as f:
            body = f.read()
        has_fn = "function sum" in body
        print(f"  [{'PASS' if has_fn else 'FAIL'}] implemented file contains `function sum`")
        ok &= has_fn

    print("\n=== FINAL VISIBLE SCREEN (tail) ===")
    print("\n".join(screen(wid).split("\n")[-16:]))
    close(wid)
    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
