#!/usr/bin/env python3
"""Drive the REAL `/scaffold` command in a pty and assert it OPENS the scaffold
wizard and that the editor cleanly hands the screen over and back:
  1. Selecting `/scaffold` from the `/` palette RUNS it (reaches the command switch,
     not a dead entry) and the wizard's first screen renders ("Choose a project type").
  2. Esc CANCELS the wizard ("cancelled — nothing was created") — the awaited
     openScaffoldInRepl path returns control without creating anything.
  3. tsforge is STILL RUNNING afterwards and the prompt is usable — proving the
     wizard's suspend/resume owned stdin alone (no double-typed-text race, the
     failure the reviewer panel flagged on the fire-and-forget browser path).

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


def main():
    t = Checker()
    srv, port = start_stub_server()
    home = tempfile.mkdtemp(prefix="tsforge-scaffold-")
    pid, m = spawn_tsforge(port, home=home, rows=24, cols=100)

    got, _ = read_until(m, lambda b: " PLAN " in b or "> " in b or "TSFORGE" in b, 40)
    t.check("REPL boots", got)

    # Run /scaffold via the palette (open with "/", filter, Enter).
    os.write(m, b"/")
    read_until(m, lambda b: "commands" in b, 10)
    os.write(m, b"scaffold\r")

    # The wizard's first screen must render — proves the command actually executed.
    opened, obuf = read_until(
        m, lambda b: "Choose a project type" in b or "tsforge scaffold" in b, 12
    )
    t.check("/scaffold RUNS and opens the wizard (first screen renders)", opened)
    t.check("no 'unknown command' when running /scaffold", "unknown command" not in obuf)

    # Type WHILE the wizard is active. Enter selects the default project type
    # (boringstack) and MUST advance the archetype step to its Review screen. If the
    # editor/readline were also consuming stdin, this keystroke would not drive the
    # wizard forward — this is what proves the wizard owns stdin (the race the panel
    # flagged on the fire-and-forget browser path).
    os.write(m, b"\r")
    reviewed, _ = read_until(
        m, lambda b: "nothing is written until you Apply" in b and "Boringstack" in b, 10
    )
    t.check("keystroke reaches the WIZARD (Enter → Review, Boringstack selected)", reviewed)

    # A second Enter applies the archetype choice and opens the config wizard whose
    # first step is "Project directory" — proving keystrokes keep flowing to the wizard.
    os.write(m, b"\r")
    advanced, _ = read_until(m, lambda b: "Project directory" in b, 10)
    t.check("wizard advances to the config step (Project directory)", advanced)

    # Esc cancels the wizard cleanly (awaited path returns, nothing created).
    os.write(m, b"\x1b")
    cancelled, _ = read_until(m, lambda b: "cancelled" in b and "nothing was created" in b, 8)
    t.check("Esc cancels the wizard — nothing was created", cancelled)

    # The REPL must survive the wizard and accept input again (suspend/resume worked).
    died = wait_for(lambda: not alive(pid), 0.8)
    t.check("tsforge STILL RUNNING after the wizard closes", not died)

    drain(m, 0.3)
    os.write(m, b"hello")
    echoed, _ = read_until(m, lambda b: "hello" in b, 5)
    t.check("prompt is usable after the wizard (editor resumed, no double-stdin)", echoed)

    reap(pid, m, exit_cmd=b"")
    srv.shutdown()
    sys.exit(t.finish())


if __name__ == "__main__":
    main()
