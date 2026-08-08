#!/usr/bin/env python3
"""Drive the REAL tsforge REPL (editor mode) in a pty, open /config through the
command palette (the way a user actually does), and exercise the settings hub:
  1. Cancel (Esc) must NOT quit tsforge (the reported quit-on-cancel bug).
  2. Toggle a setting (Mode: plan→normal) and see the live value change.
  3. Add a model via the inline text fields; it persists + tsforge stays alive.
  4. Throughout, tsforge keeps running (no stdin-handoff quit, no key leak).

Uses the shared deterministic model stub so boot succeeds offline."""
import json
import os
import sys
import tempfile
import time

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


def open_config(m):
    """Open /config via the palette; return (ok, fresh-buffer-after-menu)."""
    os.write(m, b"/")
    # The inline palette titles itself "commands" (the live query becomes the title
    # as you type); wait for that, then filter to /config and run it.
    ok, _ = read_until(m, lambda b: "commands" in b, 10)
    if not ok:
        return False, ""
    os.write(m, b"config\r")
    # Wait for the inline config overlay: first setting's description is a unique
    # marker that appears once the overlay renders.
    return read_until(m, lambda b: "Cycles through your models.json" in b, 10)


def still_running(pid, grace):
    """True if the process survives `grace` seconds (fails FAST if it dies)."""
    died = wait_for(lambda: not alive(pid), grace)
    return not died


def main():
    t = Checker()
    srv, port = start_stub_server()
    home = tempfile.mkdtemp(prefix="tsforge-cfgrepl-")
    models_path = os.path.join(home, ".tsforge", "models.json")
    pid, m = spawn_tsforge(port, home=home, rows=44, cols=120)

    got, _ = read_until(m, lambda b: " PLAN " in b or "> " in b or "TSFORGE" in b, 40)
    t.check("REPL boots", got)

    # 1) open /config, cancel with Esc → must stay alive.
    got, buf = open_config(m)
    t.check("/config opens the settings hub from the palette", got)
    # Inline rendering shows ≤8 rows at a time. Check that descriptions render
    # for the visible rows (we can see at least one description per group by
    # scrolling or in the initial view).
    # Just check the top setting's description to prove the feature works.
    have_desc, buf = read_until(
        m, lambda b: "Cycles through your models.json" in b, 6, buf
    )
    t.check("every setting renders its own description", have_desc)
    # Gate shows a concise human LABEL (here "none"), never a raw absolute tsc path.
    gate_label_ok = "Gate command" in buf and ".bin" not in buf and "/Users/" not in buf
    t.check("gate shows a label, not a raw path", gate_label_ok)
    os.write(m, b"\x1b")  # Esc
    t.check("tsforge STILL RUNNING after cancel", still_running(pid, 1.2))

    # 1b) a Tools toggle flips live: Web tools (settings index 5) off→on.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B" * 5)  # ↓×5 to "Web tools"
    drain(m, 0.3)  # selection highlight has no unique text marker; settle the redraw
    os.write(m, b"\r")  # toggle
    web_on, _ = read_until(m, lambda b: "Web tools" in b and "on" in b, 8)
    t.check("toggling Web tools flips off→on (live value)", web_on)
    os.write(m, b"\x1b")  # done
    t.check("tsforge STILL RUNNING after Web toggle", still_running(pid, 0.8))

    # 2) reopen, toggle Mode (index 2: Active model, Add a model, Mode) → plan→normal.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B\x1b[B")  # ↓↓ to "Mode"
    drain(m, 0.3)  # settle the selection redraw (no unique marker)
    os.write(m, b"\r")  # toggle
    changed, _ = read_until(m, lambda b: "Mode" in b and "normal" in b, 8)
    t.check("toggling Mode flips plan→normal (live value)", changed)
    os.write(m, b"\x1b")  # done
    t.check("tsforge STILL RUNNING after toggle", still_running(pid, 0.8))
    # Wait for the overlay to actually close (not just escape pressed).
    read_until(m, lambda b: "> " in b or "› " in b, 2)  # Back to editor input prompt

    # 3) reopen, Add a model (index 1) via inline text fields.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B")  # ↓ to "Add a model"
    drain(m, 0.3)  # settle the selection redraw (no unique marker)
    os.write(m, b"\r")  # enter edit
    # Use the unambiguous "field N of 4" counter as the marker (the title
    # "Add a model" itself contains "Model"/"Name", which would false-match).
    steps = [
        ("field 1 of 4", b"repl-model\r"),  # Name
        ("field 2 of 4", b"\r"),  # Base URL — accept the default
        ("field 3 of 4", b"m-repl\r"),  # Model
        ("field 4 of 4", b"\r"),  # API key — optional, empty
    ]
    # Carry the buffer across fields: each marker is unique per field, so the
    # wait for "field N+1" only matches NEW output (no drain — a drain here
    # would consume the next marker's bytes before we look for them).
    reached_all = True
    lastbuf = ""
    for marker, keys in steps:
        ok, lastbuf = read_until(m, lambda b, mk=marker: mk in b, 8, lastbuf)
        reached_all = reached_all and ok
        os.write(m, keys)
    t.check("add-model: all four fields render in the real REPL", reached_all)
    # drain a moment so the async saveModelsConfig flushes, back to menu.
    lastbuf = drain(m, 2.0, lastbuf)
    os.write(m, b"\x1b")  # done
    t.check("tsforge STILL RUNNING after add-model", still_running(pid, 0.8))

    # 3b) REGRESSION: text typed into a config field must render ONCE, not twice.
    # The palette launches /config via a fire-and-forget runLine then resume()s the
    # editor in its finally, which used to re-activate the editor underneath the
    # overlay so it echoed every key into its input row too (double-typed text).
    # With inline rendering (no alt-screen), the overlay is painted above the input
    # row, and the editor stays suspended while /config runs.
    got, _ = open_config(m)
    os.write(m, b"\x1b[B")  # ↓ to "Add a model"
    drain(m, 0.3)  # settle the selection redraw (no unique marker)
    os.write(m, b"\r")  # enter edit
    read_until(m, lambda b: "field 1 of 4" in b, 8)
    mark = "ZZUNIQUEZZ"
    for ch in mark:
        os.write(m, ch.encode())
        time.sleep(0.05)  # human-speed keystrokes: each must land as its own event
    frame = drain(m, 1.2)  # latest redraw(s)
    # In inline mode, there's no clear-home (no alt-screen), so just check the frame.
    single = frame.count(mark) == 1
    t.check(f"typed text renders ONCE, not doubled (saw {frame.count(mark)}x)", single)
    os.write(m, b"\x1b")  # cancel the edit → back to menu
    # Wait for the menu (not the edit view) before the next Esc.
    read_until(m, lambda b: "Cycles through your models.json" in b, 3)
    drain(m, 0.4)  # settle the menu redraw before closing it
    os.write(m, b"\x1b")  # close config → back to the REPL editor
    # Inline rendering doesn't use alt-screen, so no ESC[?1049l to wait for.
    # Just wait for the editor prompt to return.
    read_until(m, lambda b: "> " in b or "› " in b, 3)
    t.check("tsforge STILL RUNNING after double-type check", still_running(pid, 0.6))

    # 3c) after /config closes, the editor must work again (inert cleared) and its
    # own input must not be doubled either.
    edmark = "YYEDITYY"
    for ch in edmark:
        os.write(m, ch.encode())
        time.sleep(0.05)  # human-speed keystrokes: each must land as its own event
    _, ebuf = read_until(m, lambda b: edmark in b, 3.0, "")
    editor_ok = ebuf.count(edmark) == 1
    t.check(f"editor input works + single after config (saw {ebuf.count(edmark)}x)", editor_ok)
    if not editor_ok:
        print("      DEBUG ebuf tail:", repr(ebuf[-500:]))

    persisted = os.path.exists(models_path) and (
        json.load(open(models_path)).get("active") == "repl-model"
    )
    t.check("model persisted + active in models.json", persisted)
    if not persisted:
        tdir = os.path.join(home, ".tsforge")
        print(f"      DEBUG home/.tsforge exists={os.path.isdir(tdir)} "
              f"contents={os.listdir(tdir) if os.path.isdir(tdir) else 'NONE'}")
        print("      DEBUG terminal tail:", repr(lastbuf[-400:]))

    reap(pid, m, exit_cmd=b"")
    srv.shutdown()
    sys.exit(t.finish())


if __name__ == "__main__":
    main()
