import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import type { IAgent } from "../src/agent";
import type { ITask } from "../src/spec";
import { reviewRepair } from "../src/loop";

/** Provider that answers find + verify passes (keyed on the system prompt). */
function stub(findings: string, verifyReal: boolean): IProvider {
  return {
    async complete(messages) {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const body = sys.includes("verifying a code-review finding")
        ? JSON.stringify({ real: verifyReal, verdict: "judged" })
        : findings;

      return { content: body, toolCalls: [] };
    },
  };
}

const ONE_FINDING = JSON.stringify({
  findings: [
    {
      line: 2,
      severity: "error",
      lens: "correctness",
      claim: "subtraction is reversed",
      reason: "returns a negative discount",
    },
  ],
});

const NO_FINDINGS = JSON.stringify({ findings: [] });

/** A fake implement agent that writes a fixed string and records being called. */
function fakeAgent(repo: string, write: string): IAgent & { calls: number } {
  const agent = {
    calls: 0,
    async implement(): Promise<void> {
      agent.calls += 1;
      writeFileSync(join(repo, "discount.ts"), write);
    },
  };

  return agent;
}

let repo: string;
const git = (...a: string[]): void =>
  void execFileSync("git", a, { cwd: repo, stdio: "ignore" });

const CHANGED = "// discount\nconst x = off - price;\n";

function task(accept: string): ITask {
  return { id: "t", accept, files: ["discount.ts"], context: [] };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tsforge-revrepair-"));
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    join(repo, "discount.ts"),
    "// discount\nconst x = price - off;\n"
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // an uncommitted change on line 2 — the diff under review
  writeFileSync(join(repo, "discount.ts"), CHANGED);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("no verified findings → no repair, agent never called", async () => {
  const agent = fakeAgent(repo, "should not be written");
  const res = await reviewRepair(
    stub(NO_FINDINGS, true),
    repo,
    task("true"),
    agent
  );

  expect(res.findings).toBe(0);
  expect(res.repaired).toBe(false);
  expect(res.reverted).toBe(false);
  expect(agent.calls).toBe(0);
});

test("verified finding + a repair that keeps the gate green → repaired, kept", async () => {
  // gate passes only when the file contains REPAIRED; the agent writes it.
  const agent = fakeAgent(repo, "// REPAIRED\nconst x = price - off;\n");
  const res = await reviewRepair(
    stub(ONE_FINDING, true),
    repo,
    task("grep -q REPAIRED discount.ts"),
    agent
  );

  expect(res.findings).toBe(1);
  expect(res.repaired).toBe(true);
  expect(res.reverted).toBe(false);
  expect(agent.calls).toBe(1);
  expect(readFileSync(join(repo, "discount.ts"), "utf8")).toContain("REPAIRED");
});

test("verified finding + a repair that breaks the gate → reverted, file restored", async () => {
  // gate requires REPAIRED, but the agent writes garbage that lacks it → revert.
  const agent = fakeAgent(repo, "// BROKEN garbage\n");
  const res = await reviewRepair(
    stub(ONE_FINDING, true),
    repo,
    task("grep -q REPAIRED discount.ts"),
    agent
  );

  expect(res.findings).toBe(1);
  expect(res.repaired).toBe(false);
  expect(res.reverted).toBe(true);
  expect(agent.calls).toBe(1);
  // the pre-repair (uncommitted) content is restored verbatim
  expect(readFileSync(join(repo, "discount.ts"), "utf8")).toBe(CHANGED);
});

test("a revert emits a `reverted` accounting event", async () => {
  const events: string[] = [];
  const agent = fakeAgent(repo, "// BROKEN\n");

  await reviewRepair(
    stub(ONE_FINDING, true),
    repo,
    task("grep -q REPAIRED discount.ts"),
    agent,
    { onEvent: (e) => events.push(e.kind) }
  );

  expect(events).toContain("reverted");
});
