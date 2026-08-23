#!/usr/bin/env python3
"""Real-PTY coverage for Phaser product planning in the pane editor.

This is the path that dumped a JSON blob and then re-planned when the user
typed `approve` (pane editor, rl is null, default plan mode).

Drives the REAL tsforge REPL against the stub model:

  1. Boot on a Phaser scaffold receipt (editor, not readline).
  2. Type a product line → planner returns a Coin slice as JSON.
  3. Assert the yellow PLAN card (Coin, type approve to build) — not a JSON dump,
     not "planning cancelled".
  4. Assert the product-planner row in the live agent tree.
  5. Type `approve` → plan approved, NOT a second "planning your product first".

Does not wait for the Phaser generate/wire build after approve.

Run: python3 scripts/e2e-phaser-plan-pty.py
"""
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    content_chunks,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    visible_text,
)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ROWS, COLS = 40, 120
PLANNER_EXAMPLE = {
    "product": (
        "A side-scrolling flap game: tap to rise, fall with gravity, "
        "dodge scrolling pipe pairs, score for each gap passed."
    ),
    "slices": [
        {
            "entity": {
                "id": "Flap",
                "desc": "Gravity pulls the bird down; a tap adds an upward impulse.",
                "fields": [
                    {"name": "vy", "type": "number"},
                    {"name": "alive", "type": "boolean"},
                ],
                "relationships": ["drives the bird sprite on World"],
                "rules": ["a flap while dead does nothing"],
            },
            "ui": {
                "kind": "feature",
                "scene": "World",
                "feature": "flap",
                "input": "pointer",
            },
            "verification": {
                "mustRemainTrue": ["without input the bird's vy increases downward"],
                "mustNotHappen": ["the bird flies with no gravity"],
                "acceptanceCheck": "bun test",
            },
        }
    ],
}


def strip(text):
    return ANSI.sub("", text)


def _decide(messages):
    joined_sys = " ".join(
        m.get("content") or ""
        for m in messages
        if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    if "game designer for a Phaser" in joined_sys or "product architect for a Phaser" in joined_sys:
        return content_chunks(json.dumps(PLANNER_EXAMPLE))
    return content_chunks("ok")


def seed_phaser(work):
    tsforge = os.path.join(work, ".tsforge")
    os.makedirs(tsforge)
    with open(os.path.join(tsforge, "scaffold.json"), "w") as f:
        json.dump({"archetype": "phaser"}, f)
    with open(os.path.join(work, "package.json"), "w") as f:
        json.dump({"name": "game"}, f)


def scenario(port):
    print("\n# Phaser product plan card + approve (real pane editor)")
    t = Checker()
    work = tempfile.mkdtemp(prefix="tsforge-phaser-pty-")
    home = tempfile.mkdtemp(prefix="tsforge-phaser-home-")
    seed_phaser(work)
    pid, master = spawn_tsforge(
        port,
        extra_env={"TSFORGE_NO_REVIEW": "1"},
        cwd=work,
        home=home,
        rows=ROWS,
        cols=COLS,
    )
    buf = ""
    try:
        got, buf = read_until(master, lambda b: " PLAN " in b, 60)
        t.check("boots into plan mode (pane editor)", got)

        os.write(master, b"add collectible coins to the world\r")
        got, buf = read_until(
            master, lambda b: "planning your product first" in strip(b).lower(), 30, buf
        )
        t.check("starts product planning (not a silent hang)", got)

        got, buf = read_until(
            master,
            lambda b: "type approve to build" in strip(b).lower()
            or ("Flap" in strip(b) and "PLAN" in strip(b)),
            30,
            buf,
        )
        t.check("PLAN card landed (Flap / type approve to build)", got)

        plain = strip(buf).lower()
        t.check(
            "did NOT auto-cancel in the pane editor",
            "planning cancelled" not in plain,
        )
        vis = visible_text(buf, rows=ROWS, cols=COLS)
        vis_plain = strip(vis)
        t.check("visible screen is not a raw slices JSON dump", '"slices"' not in vis_plain)
        t.check("visible screen is not mustRemainTrue JSON", "mustRemainTrue" not in vis_plain)
        t.check(
            "product planner appears in the agent tree",
            "product planner" in strip(buf).lower() or "product planner" in vis_plain.lower(),
        )

        os.write(master, b"approve\r")
        got, buf = read_until(
            master, lambda b: "plan approved" in strip(b).lower(), 20, buf
        )
        t.check("'approve' binds the presented plan", got)

        specs = os.path.join(work, ".specs", "next.md")
        body = ""
        if os.path.exists(specs):
            with open(specs) as f:
                body = f.read()
        t.check(
            "product plan file is approved (not a fresh draft from a second planner)",
            "status: approved" in body,
            body[:200],
        )
        vis = strip(visible_text(buf, rows=ROWS, cols=COLS)).lower()
        t.check(
            "screen still shows the Flap PLAN card after approve",
            "flap" in vis and "plan" in vis,
        )
        t.check(
            "screen did not dump slices JSON after approve",
            '"slices"' not in vis and "mustremaintrue" not in vis,
        )
    finally:
        reap(pid, master)
    return t.finish()


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    try:
        return scenario(port)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
