#!/usr/bin/env python3
"""Drive the generic wizard in a REAL pty: pick a single-select, then type into a
text field (erase the default, type new), and confirm. Asserts the rendered frames
and the final {single, text} result — verifying the primitive works in a real
terminal, not just via the pure reducer. Deterministic; no model needed."""
import os
import pty
import select
import struct
import fcntl
import termios
import time
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(REPO, "packages/core/scripts/wizard-harness.ts")


def read_until(m, marker, timeout, buf=""):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([m], [], [], 0.3)
        if m in r:
            try:
                d = os.read(m, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf


def main():
    ok = True
    pid, m = pty.fork()
    if pid == 0:
        os.execvpe(
            "bun", ["bun", HARNESS], dict(os.environ, TSFORGE_NO_UPDATE_CHECK="1")
        )
        os._exit(127)
    fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    got, _ = read_until(m, lambda b: "Pick one" in b, 30)
    print(f"  [{'PASS' if got else 'FAIL'}] wizard renders the first step")
    ok &= got

    os.write(m, b"\r")  # confirm single (alpha) → advance to the text step
    got, _ = read_until(m, lambda b: "Name" in b, 10)
    print(f"  [{'PASS' if got else 'FAIL'}] advances to the text step")
    ok &= got

    os.write(m, b"\x7f\x7f\x7f\x7f")  # erase "seed"
    os.write(m, b"x y")  # type "x y" — the space MUST land (regression: space→toggle)
    os.write(m, b"\r")  # confirm (review:false) → apply

    got, buf = read_until(m, lambda b: "RESULT" in b, 10)
    print(f"  [{'PASS' if got else 'FAIL'}] finishes and prints RESULT")
    ok &= got

    tail = buf.split("RESULT")[-1].strip() if got else ""
    good = (
        got
        and '"status":"apply"' in tail
        and '"name":"x y"' in tail  # the space survived
        and '"pick":"alpha"' in tail
    )
    print(f"  [{'PASS' if good else 'FAIL'}] result: single=alpha, text='x y' (space typed)   {tail[:80]!r}")
    ok &= good

    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass

    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
