#!/usr/bin/env python3
"""Drive the REAL tsforge REPL in a pty through the review → /reviewfix flow and
prove the findings→task-list bridge on the actual binary:

  1. /review runs the AGENTIC reviewer (investigate via git_context, then report a
     grounded finding) and prints a finding card.
  2. /reviewfix seeds the WORKLIST — one task per finding — instead of dumping prose:
     the plan file on disk holds one open task, and the REPL says so.

The scenario model is scripted through the shared stub: the reviewer agent gets a
git_context call then an agent_result with one finding at foo.ts:2; the post-/reviewfix
fix turn just acknowledges (the assertion is about seeding, not the fix)."""
import glob
import json
import os
import subprocess
import sys
import tempfile

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
)


def make_repo():
    """A git repo with a committed baseline and an uncommitted change on foo.ts:2 —
    the diff the reviewer sees."""
    repo = tempfile.mkdtemp(prefix="tsforge-reviewfix-")
    g = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=repo, check=True, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with open(os.path.join(repo, "foo.ts"), "w") as f:
        f.write("export const a = 1;\nexport const b = 2;\n")
    g("init", "-q")
    g("config", "user.email", "t@t.t")
    g("config", "user.name", "t")
    g("config", "commit.gpgsign", "false")
    g("add", "-A")
    g("commit", "-q", "-m", "baseline")
    # the change under review
    with open(os.path.join(repo, "foo.ts"), "w") as f:
        f.write("export const a = 1;\nexport const b = 99;\n")
    return repo


def decide(messages):
    """Scenario logic. The reviewer agent is recognized by its task text; it gets a
    git_context call first, then an agent_result once a tool result is present. Any
    other turn (the /reviewfix fix turn) just acknowledges."""
    blob = json.dumps(messages)
    is_reviewer = "Review this change as a whole" in blob
    has_tool_result = any(m.get("role") == "tool" for m in messages)

    if is_reviewer and not has_tool_result:
        return toolcall_chunks("git_context", {"op": "diff"})
    if is_reviewer:
        return toolcall_chunks(
            "agent_result",
            {
                "summary": "found one issue",
                "findings": [
                    {
                        "detail": "b flipped from 2 to 99 — unintended value change",
                        "source": "foo.ts:2",
                        "confidence": "high",
                    }
                ],
            },
        )
    return content_chunks("Acknowledged — I'll work the task list.")


def worklist_items(repo):
    """The tasks persisted by /reviewfix (title list), or [] if no plan yet."""
    plans = glob.glob(os.path.join(repo, ".tsforge", "worklist", "plans", "*.json"))
    if not plans:
        return []
    with open(plans[0]) as f:
        doc = json.load(f)
    return [i.get("title", "") for i in doc.get("items", [])]


def main():
    t = Checker()
    repo = make_repo()
    srv, port = start_stub_server(decide)
    home = os.path.join(repo, ".home")
    pid, m = spawn_tsforge(
        port,
        cwd=repo,
        home=home,
        rows=44,
        cols=120,
        extra_env={"TSFORGE_BASIC_INPUT": "1", "TSFORGE_NO_REVIEW": "1"},
        args=("--policy-mode", "dontAsk", "--no-gate"),
    )

    try:
        got, buf = read_until(m, lambda b: "> " in b or "TSFORGE" in b, 40)
        t.check("REPL boots", got)

        # 1) /review → the agentic reviewer reports a grounded finding.
        os.write(m, b"/review\r")
        got, buf = read_until(
            m, lambda b: "finding(s)" in b or "foo.ts:2" in b, 60, buf
        )
        t.check("/review prints a finding from the agentic reviewer", got)

        # 2) /reviewfix → seed the worklist (one task per finding), not a prose dump.
        os.write(m, b"/reviewfix\r")
        got, buf = read_until(
            m, lambda b: "added 1 finding(s) to the task list" in b, 30, buf
        )
        t.check("/reviewfix reports seeding the task list", got)

        # settle so the plan file is flushed before we read it
        drain(m, 1.5, buf)
        items = worklist_items(repo)
        t.check("worklist has exactly one task (one per finding)", len(items) == 1)
        t.check(
            "the task title is the finding's claim",
            len(items) == 1 and "99" in items[0],
            detail=f"titles={items}",
        )
    finally:
        reap(pid, m)
        srv.shutdown()

    return t.finish()


if __name__ == "__main__":
    sys.exit(main())
