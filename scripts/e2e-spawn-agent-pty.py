#!/usr/bin/env python3
"""Real-PTY e2e for model-driven delegation (the `spawn_agent` tool + live tree).

Drives the REAL tsforge REPL in a REAL pty against the deterministic stub model.
The stub plays TWO roles keyed off the system prompt: as the ORCHESTRATOR it
emits two `spawn_agent` tool calls in one turn; as a SUBAGENT (built-in explore
spec) it must investigate first (the runner forces a tool call), then answers.
We assert on the REAL byte stream that the live agent tree rendered — header,
both child rows, the focused agent's output pane — and that the orchestrator got
the findings back and produced a final answer.

Run: python3 scripts/e2e-spawn-agent-pty.py
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
    sse,
    spawn_tsforge,
    start_stub_server,
)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip(text):
    return ANSI.sub("", text)


def two_spawns():
    """One assistant turn emitting TWO parallel spawn_agent tool calls."""
    yield sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_a",
                                "type": "function",
                                "function": {
                                    "name": "spawn_agent",
                                    "arguments": json.dumps(
                                        {
                                            "subagent_type": "explore",
                                            "description": "trace scheduler",
                                            "prompt": "How does AgentScheduler cap concurrency? Cite file:line.",
                                        }
                                    ),
                                },
                            },
                            {
                                "index": 1,
                                "id": "call_b",
                                "type": "function",
                                "function": {
                                    "name": "spawn_agent",
                                    "arguments": json.dumps(
                                        {
                                            "subagent_type": "verify",
                                            "description": "check abort race",
                                            "prompt": "Is there an abort race in AgentScheduler? Cite file:line.",
                                        }
                                    ),
                                },
                            },
                        ]
                    },
                }
            ]
        }
    )


def search_call():
    yield sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_s",
                                "type": "function",
                                "function": {
                                    "name": "search",
                                    "arguments": json.dumps({"pattern": "concurrency"}),
                                },
                            }
                        ]
                    },
                }
            ]
        }
    )


def _decide(messages):
    system = ""
    if messages and messages[0].get("role") == "system":
        system = messages[0].get("content") or ""
    last = messages[-1] if messages else {}
    is_orchestrator = "DELEGATION" in system

    if is_orchestrator:
        if last.get("role") == "tool":
            return content_chunks(
                "Both specialists confirm AgentScheduler caps concurrency and wires "
                "per-unit AbortControllers. Done."
            )
        return two_spawns()

    # A subagent (built-in explore/verify). The runner forces a tool call first,
    # so search, then answer once the tool result is back.
    if last.get("role") == "tool":
        return content_chunks("Confirmed at agent-scheduler.ts:60 — cap honored.")
    return search_call()


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    chk = Checker()

    work = tempfile.mkdtemp(prefix="tsforge-spawn-")
    home = tempfile.mkdtemp(prefix="tsforge-home-")
    # Editor mode (the default): the live agent tree renders in the pinned region.
    pid, master = spawn_tsforge(port, {}, cwd=work, home=home)
    try:
        read_until(master, lambda b: "◆ plan" in b, 60)
        # Switch to normal mode (Shift+Tab, editor) so the orchestrator acts.
        os.write(master, b"\x1b[Z")
        _, buf = read_until(master, lambda b: "◆ normal" in b, 15)

        os.write(master, b"Explain how AgentScheduler caps concurrency.\r")

        # Accumulate through the orchestrator's post-delegation answer so every
        # frame the tree painted is in the captured stream (erased frames stay in
        # the byte stream — the erase is an escape sequence, not a deletion).
        got, buf = read_until(master, lambda b: "Done." in strip(b), 60, buf)
        clean = strip(buf)

        chk.check("orchestrator produced a final answer after delegating", got)
        chk.check("live agent tree header rendered (● agents)", "● agents" in clean)
        chk.check("tree connectors rendered", "├─" in clean or "└─" in clean)
        chk.check(
            "both spawned rows shown with their labels",
            "trace scheduler" in clean and "check abort race" in clean,
        )
        chk.check("focused agent output pane shown (↳ <label>)", "↳ trace" in clean)
    finally:
        reap(pid, master)

    srv.shutdown()
    sys.exit(chk.finish())


if __name__ == "__main__":
    main()
