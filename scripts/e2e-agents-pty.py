#!/usr/bin/env python3
"""Real-PTY reality test for the live agent tree (`tsforge agents`).

Drives the REAL tsforge CLI in a REAL pseudo-terminal against the deterministic
stub model, fans out two read-only subagents over a task, and asserts on the
REAL byte stream that the Claude-Code-style tree actually rendered: the `● agents`
header, per-child rows with tree connectors, a running spinner frame, done ✓
glyphs, and the final result blocks. Erased frames stay in the captured stream
(the erase is an escape sequence, not a deletion), so we can assert a running
frame was shown even though the stub answers near-instantly.

Run: python3 scripts/e2e-agents-pty.py
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
    toolcall_chunks,
)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip(text):
    """Remove ANSI escape sequences so tree glyphs assert as plain substrings."""
    return ANSI.sub("", text)


def _decide(messages):
    """A read-only (text) subagent, realistically: the runner forces a tool call
    first (no answering from memory), so investigate (search) then answer once the
    tool result is back. (These specs are text-mode — `agent_result` isn't offered
    to them, so we must NOT fake it.)"""
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        return content_chunks("Explored the workspace — mapped the entry points.")
    return toolcall_chunks("search", {"pattern": "export"})


def _write_spec(agents_dir, spec_id, description):
    with open(os.path.join(agents_dir, f"{spec_id}.json"), "w") as f:
        json.dump({"id": spec_id, "description": description, "maxTurns": 5}, f)


def spawn(port):
    """Fork `tsforge agents explore,verify "<task>"` into a real pty."""
    work = tempfile.mkdtemp(prefix="tsforge-agents-")
    home = tempfile.mkdtemp(prefix="tsforge-home-")
    agents_dir = os.path.join(work, ".tsforge", "agents")
    os.makedirs(agents_dir)
    _write_spec(agents_dir, "explore", "map the workspace")
    _write_spec(agents_dir, "verify", "double-check the findings")

    pid, master = spawn_tsforge(
        port,
        {},
        cwd=work,
        home=home,
        args=("agents", "explore,verify", "Summarize this repo."),
    )
    return pid, master


def scenario(port, chk):
    print("\n# live agent tree (tsforge agents, real pty)")
    pid, master = spawn(port)
    try:
        # Wait for both result blocks (plain text, printed after the tree clears).
        got, buf = read_until(
            master, lambda b: "=== verify:" in b and "=== explore:" in b, 60
        )
        clean = strip(buf)

        chk.check("tree header rendered (● agents)", "● agents" in clean, clean[-400:])
        chk.check(
            "tree connectors rendered (├─ / └─)",
            "├─" in clean or "└─" in clean,
            clean[-400:],
        )
        chk.check(
            "a running frame was shown (header said 'running')",
            "running" in clean,
        )
        chk.check("explore finished done (✓)", "✓" in clean and "explore" in clean)
        chk.check(
            "both result blocks printed",
            got and "=== explore: done" in buf and "=== verify: done" in buf,
        )
    finally:
        # One-shot command: it exits on its own; reap without an /exit cmd.
        reap(pid, master, exit_cmd=b"")


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    chk = Checker()
    try:
        scenario(port, chk)
    finally:
        srv.shutdown()
    sys.exit(chk.finish())


if __name__ == "__main__":
    main()
