#!/usr/bin/env python3
"""Pathological-SSE reality test: drive the REAL tsforge CLI in a pty against a
stub model server that emits the wire shapes flaky backends actually produce —
and assert the harness handles each one the fixed way, end to end (real SSE
parsing, real loop steering, real tool execution).

Scenarios (one fresh REPL each):
  A. Parallel tool calls with NO `index` field (Mistral-compat shape): both
     calls must survive as distinct calls — both files created — with the
     one-time "missing index" notice in the stream. (Pre-fix: both calls fused
     into slot 0, args concatenated → parsed to {} → nothing created.)
  B. A tool call cut off by the token cap (finish_reason: "length", args cut
     mid-JSON): the broken call must NOT execute; the loop re-steers with the
     smaller-call message and the follow-up call succeeds. (Pre-fix: executed
     with silently-empty {} args → reject loop.)
  C. A mid-stream SSE error event after content tokens: the error must surface
     (not read as "the model said nothing"), the already-streamed content must
     not be duplicated by a hidden retry, and the REPL must survive.

Run: python3 scripts/e2e-inference-pathological-pty.py
"""
import json
import os
import re
import select
import shutil
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    content_chunks,
    reap,
    spawn_tsforge,
    sse,
    start_stub_server,
)

ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]")


def drive(decide, task, ws, timeout_s=90, done=lambda plain, calls: False):
    """Spawn the real CLI on `task`, stream until `done` or timeout; return
    (plain_text, ws)."""
    srv, port = start_stub_server(decide)
    pid, master = spawn_tsforge(
        port,
        cwd=ws,
        home=os.path.join(ws, ".home"),
        extra_env={"TSFORGE_BASIC_INPUT": "1"},
        args=(task, "--policy-mode", "dontAsk", "--no-gate"),
    )
    buf = b""
    end = time.monotonic() + timeout_s
    try:
        while time.monotonic() < end:
            r, _, _ = select.select([master], [], [], 0.5)
            if r:
                try:
                    buf += os.read(master, 65536)
                except OSError:
                    break
            plain = ANSI.sub(b"", buf).decode("utf8", "replace")
            if done(plain, None):
                time.sleep(1.5)
                try:
                    r2, _, _ = select.select([master], [], [], 0.2)
                    if r2:
                        buf += os.read(master, 262144)
                except OSError:
                    pass
                break
        return ANSI.sub(b"", buf).decode("utf8", "replace")
    finally:
        reap(pid, master)
        srv.shutdown()


def fresh_ws(name):
    ws = os.path.join(os.path.expanduser("~"), f".tsforge-e2e-{name}")
    shutil.rmtree(ws, ignore_errors=True)
    os.makedirs(os.path.join(ws, "src"), exist_ok=True)
    with open(os.path.join(ws, "package.json"), "w") as f:
        f.write('{"name":"e2e"}')
    return ws


def tc(index=None, call_id=None, name=None, args=None):
    """One raw tool_call delta entry, with exactly the fields given."""
    entry = {"type": "function", "function": {}}
    if index is not None:
        entry["index"] = index
    if call_id is not None:
        entry["id"] = call_id
    if name is not None:
        entry["function"]["name"] = name
    if args is not None:
        entry["function"]["arguments"] = args
    return sse({"choices": [{"delta": {"tool_calls": [entry]}}]})


def scenario_no_index():
    print("\n# A. parallel tool calls with NO index field")
    ws = fresh_ws("noindex")
    calls = {"n": 0}

    def decide(messages):
        calls["n"] += 1
        if calls["n"] == 1:
            # Two creates, NO index anywhere — boundaries only via new ids.
            yield tc(call_id="call_a", name="create", args="")
            yield tc(args=json.dumps({"file": "src/a.ts", "content": "export const a = 1;\n"}))
            yield tc(call_id="call_b", name="create", args="")
            yield tc(args=json.dumps({"file": "src/b.ts", "content": "export const b = 2;\n"}))
        else:
            yield from content_chunks("done - task complete")

    a_path = os.path.join(ws, "src", "a.ts")
    b_path = os.path.join(ws, "src", "b.ts")
    plain = drive(
        decide,
        "create the two files",
        ws,
        done=lambda p, _: os.path.exists(a_path) and os.path.exists(b_path),
    )

    ok = True
    both = os.path.exists(a_path) and os.path.exists(b_path)
    print(f"  [{'PASS' if both else 'FAIL'}] BOTH files created (calls not fused into slot 0)")
    ok &= both
    warned = "missing index" in plain
    print(f"  [{'PASS' if warned else 'FAIL'}] one-time 'missing index' notice shown")
    ok &= warned
    if both:
        with open(a_path) as f:
            a_ok = "const a" in f.read()
        with open(b_path) as f:
            b_ok = "const b" in f.read()
        print(f"  [{'PASS' if a_ok and b_ok else 'FAIL'}] each file has ITS OWN content (args not concatenated)")
        ok &= a_ok and b_ok
    shutil.rmtree(ws, ignore_errors=True)
    return ok


def scenario_truncated():
    print("\n# B. tool call cut off by the token cap (finish_reason: length)")
    ws = fresh_ws("trunc")
    calls = {"n": 0}

    def decide(messages):
        calls["n"] += 1
        if calls["n"] == 1:
            # A create whose args are cut mid-JSON + finish_reason: "length".
            yield tc(index=0, call_id="c1", name="create",
                     args='{"file":"src/broken.ts","content":"export const x =')
            yield sse({"choices": [{"delta": {}, "finish_reason": "length"}]})
        elif calls["n"] == 2:
            yield tc(index=0, call_id="c2", name="create",
                     args=json.dumps({"file": "src/ok.ts", "content": "export const ok = 1;\n"}))
        else:
            yield from content_chunks("done - task complete")

    ok_path = os.path.join(ws, "src", "ok.ts")
    plain = drive(
        decide,
        "write the file",
        ws,
        done=lambda p, _: os.path.exists(ok_path),
    )

    ok = True
    no_broken = not os.path.exists(os.path.join(ws, "src", "broken.ts"))
    print(f"  [{'PASS' if no_broken else 'FAIL'}] the truncated call did NOT execute")
    ok &= no_broken
    steered = "token cap" in plain or "CUT OFF" in plain
    print(f"  [{'PASS' if steered else 'FAIL'}] the truncation resteer is visible")
    ok &= steered
    recovered = os.path.exists(ok_path)
    print(f"  [{'PASS' if recovered else 'FAIL'}] the smaller follow-up call succeeded")
    ok &= recovered
    shutil.rmtree(ws, ignore_errors=True)
    return ok


def scenario_midstream_error():
    print("\n# C. SSE error event after content tokens")
    ws = fresh_ws("sseerr")
    # Count IDENTICAL re-sends of the failing request — the true duplicate
    # signal. (Screen-text counts over-count: the pane repaints rows.)
    sends = {"task_requests": 0}

    def decide(messages):
        last_user = next(
            (m for m in reversed(messages) if m.get("role") == "user"), {}
        )
        if "say hello" in (last_user.get("content") or ""):
            sends["task_requests"] += 1
        yield from content_chunks("PARTIALPREFIX ")
        yield sse({"error": {"message": "internal inference fault", "code": 500}})

    plain = drive(
        decide,
        "say hello",
        ws,
        timeout_s=60,
        done=lambda p, _: "inference fault" in p or "failed" in p,
    )

    ok = True
    surfaced = "inference fault" in plain or "model request failed" in plain
    print(f"  [{'PASS' if surfaced else 'FAIL'}] the mid-stream error surfaced (not read as silence)")
    ok &= surfaced
    once = sends["task_requests"] == 1
    print(f"  [{'PASS' if once else 'FAIL'}] the failing request was NOT hidden-retried (sent {sends['task_requests']}x)")
    ok &= once
    shutil.rmtree(ws, ignore_errors=True)
    return ok


def main():
    results = [scenario_no_index(), scenario_truncated(), scenario_midstream_error()]
    passed = sum(1 for r in results if r)
    print(f"\n==== {passed}/{len(results)} scenarios — {'ALL PASS' if passed == len(results) else 'FAILURES'} ====")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
