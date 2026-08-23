#!/usr/bin/env python3
"""Real-PTY coverage for the harness regressions: ghost mouse CSI, Ctrl+C
abort of product planning, Ctrl+G rail toggle, mouse restore on quit.

Stub model, real tsforge pane console. Run:
  python3 scripts/e2e-harness-invariants-pty.py
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    content_chunks,
    drain,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    toolcall_chunks,
    visible_text,
    alive,
)

ROWS, COLS = 40, 120
PLANNER_JSON = json.dumps(
    {
        "product": "A flap game",
        "slices": [
            {
                "entity": {
                    "id": "Flap",
                    "desc": "tap to rise",
                    "fields": [{"name": "vy", "type": "number"}],
                    "relationships": [],
                    "rules": [],
                },
                "ui": {
                    "kind": "feature",
                    "scene": "World",
                    "feature": "flap",
                    "input": "pointer",
                },
                "verification": {
                    "mustRemainTrue": ["gravity"],
                    "mustNotHappen": ["no gravity"],
                    "acceptanceCheck": "bun test",
                },
            }
        ],
    }
)


def _decide(messages):
    # Planning is routed through the real turn loop (ask_user +
    # propose_product_plan), not a one-shot raw completion — the trigger is
    # "is this the planning turn" (the exact line runGreenfieldPlanning
    # sends), and the reply is a TOOL CALL, not JSON text. The sleep just
    # gives the test's Ctrl+C time to land before this call would resolve —
    # this scenario cancels before any response matters.
    last = messages[-1] if messages else {}
    if (
        last.get("role") == "user"
        and isinstance(last.get("content"), str)
        and last["content"].startswith("Product description:")
    ):
        time.sleep(2.5)
        return toolcall_chunks("propose_product_plan", json.loads(PLANNER_JSON))
    return content_chunks("ok")


def seed_phaser(work):
    tsforge = os.path.join(work, ".tsforge")
    os.makedirs(tsforge)
    with open(os.path.join(tsforge, "scaffold.json"), "w") as f:
        json.dump({"archetype": "phaser"}, f)
    with open(os.path.join(work, "package.json"), "w") as f:
        json.dump({"name": "game"}, f)


def boot(port, work):
    home = tempfile.mkdtemp(prefix="tsforge-inv-home-")
    pid, master = spawn_tsforge(
        port,
        extra_env={"TSFORGE_NO_REVIEW": "1"},
        cwd=work,
        home=home,
        rows=ROWS,
        cols=COLS,
    )
    got, buf = read_until(master, lambda b: " PLAN " in b, 60)
    return pid, master, got, buf


def scenario_idle_mouse(port):
    print("\n# idle boot: mouse CSI is not a prompt")
    t = Checker()
    work = tempfile.mkdtemp(prefix="tsforge-inv-idle-")
    seed_phaser(work)
    pid, master, got, buf = boot(port, work)
    try:
        t.check("boots into plan mode", got)
        os.write(master, b"\x1b[<0;23;22M")
        buf = drain(master, 2.0, buf)
        plain = buf.lower()
        t.check(
            "mouse CSI did not start product planning",
            "planning your product first" not in plain,
        )
        t.check(
            "mouse CSI did not appear as a user bubble",
            "0;23;22" not in visible_text(buf, rows=ROWS, cols=COLS),
        )
    finally:
        reap(pid, master)
    return t.finish()


def scenario_ctrl_c_cancels_planner(port):
    print("\n# Ctrl+C aborts in-flight product planning")
    t = Checker()
    work = tempfile.mkdtemp(prefix="tsforge-inv-cc-")
    seed_phaser(work)
    pid, master, got, buf = boot(port, work)
    try:
        t.check("boots into plan mode", got)
        os.write(master, b"add a flap game\r")
        got, buf = read_until(
            master,
            lambda b: "planning your product first" in b.lower(),
            20,
            buf,
        )
        t.check("planner started", got)
        os.write(master, b"\x03")
        got, buf = read_until(
            master,
            lambda b: "planner cancelled" in b.lower() or "cancelled" in b.lower(),
            8,
            buf,
        )
        t.check("Ctrl+C cancelled the planner", got)
        t.check("process still alive after Ctrl+C", alive(pid))
        vis = visible_text(buf, rows=ROWS, cols=COLS)
        t.check("still in the pane (plan chip or prompt)", "PLAN" in vis or "TSFORGE" in vis)
    finally:
        reap(pid, master)
    return t.finish()


def scenario_ctrl_g(port):
    print("\n# Ctrl+G reaches the pane (rail toggle)")
    t = Checker()
    work = tempfile.mkdtemp(prefix="tsforge-inv-g-")
    seed_phaser(work)
    pid, master, got, buf = boot(port, work)
    try:
        t.check("boots into plan mode", got)
        before = visible_text(buf, rows=ROWS, cols=COLS)
        os.write(master, b"\x07")
        buf = drain(master, 1.2, buf)
        after = visible_text(buf, rows=ROWS, cols=COLS)
        t.check("process still alive after Ctrl+G", alive(pid))
        t.check(
            "Ctrl+G changed the pane (or kept TSFORGE chrome)",
            "TSFORGE" in after,
        )
        t.check(
            "Ctrl+G was not typed into the prompt as a glyph",
            after.count(before) != 1 or "TSFORGE" in after,
        )
    finally:
        reap(pid, master)
    return t.finish()


def scenario_quit_restores_mouse(port):
    print("\n# idle Ctrl+C quits and restores mouse tracking off")
    t = Checker()
    work = tempfile.mkdtemp(prefix="tsforge-inv-exit-")
    seed_phaser(work)
    pid, master, got, buf = boot(port, work)
    try:
        t.check("boots into plan mode", got)
        # Idle Ctrl+C is quit (editor interrupt). `/exit` opens the slash palette.
        os.write(master, b"\x03")
        buf = drain(master, 4.0, buf)
        restored = (
            "\x1b[?1000l" in buf
            or "\x1b[?1006l" in buf
            or "\x1b[?1049l" in buf
            or "?1000l" in buf
            or "?1006l" in buf
            or "?1049l" in buf
        )
        t.check(
            "quit leaves alt screen / disables mouse",
            restored,
            buf[-300:].replace("\x1b", "ESC"),
        )
    finally:
        reap(pid, master, exit_cmd=b"")
    return t.finish()


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    failed = 0
    try:
        failed += scenario_idle_mouse(port)
        failed += scenario_ctrl_c_cancels_planner(port)
        failed += scenario_ctrl_g(port)
        failed += scenario_quit_restores_mouse(port)
    finally:
        srv.shutdown()
    return failed


if __name__ == "__main__":
    sys.exit(main())
