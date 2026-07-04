#!/usr/bin/env python3
"""Drive the generic wizard in a REAL pty: pick a single-select, then type into a
text field (erase the default, type new), and confirm. Asserts the rendered frames
and the final {single, text} result — verifying the primitive works in a real
terminal, not just via the pure reducer. Deterministic; no model needed."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import Checker, REPO, read_until, reap, spawn_pty  # noqa: E402

HARNESS = os.path.join(REPO, "packages/core/scripts/wizard-harness.ts")


def main():
    t = Checker()
    pid, m = spawn_pty(["bun", HARNESS], env={"NO_UPDATE_NOTIFIER": "1"})

    try:
        got, _ = read_until(m, lambda b: "Pick one" in b, 30)
        t.check("wizard renders the first step", got)

        os.write(m, b"\r")  # confirm single (alpha) → advance to the text step
        got, _ = read_until(m, lambda b: "Name" in b, 15)
        t.check("advances to the text step", got)

        os.write(m, b"\x7f\x7f\x7f\x7f")  # erase "seed"
        os.write(m, b"x y")  # type "x y" — the space MUST land (regression: space→toggle)
        os.write(m, b"\r")  # confirm (review:false) → apply

        got, buf = read_until(m, lambda b: "RESULT" in b, 15)
        t.check("finishes and prints RESULT", got)

        tail = buf.split("RESULT")[-1].strip() if got else ""
        good = (
            got
            and '"status":"apply"' in tail
            and '"name":"x y"' in tail  # the space survived
            and '"pick":"alpha"' in tail
        )
        t.check(f"result: single=alpha, text='x y' (space typed)   {tail[:80]!r}", good)
    finally:
        reap(pid, m, exit_cmd=b"")  # the harness exits on its own; just make sure

    sys.exit(t.finish())


if __name__ == "__main__":
    main()
