import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/loop";
import type { IChatMessage, IProvider } from "../src/inference";

// ── C4: the MAIN loop recovers from a context-overflow rejection ─────────────
// The subagent runner has had reactive overflow recovery for a while; the
// Session only had the proactive lastUsage check — blind after any turn that
// returned no usage. One context-length 400 ended the send as stuck, nothing
// ever shrank the transcript, every later send re-overflowed, and --continue
// faithfully restored the dead state.
test("Session compacts and retries on a context-overflow rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-sess-overflow-"));

  let calls = 0;
  let compactions = 0;
  const provider: IProvider = {
    async complete(messages: readonly IChatMessage[]) {
      // The compaction summarizer call is recognizable by its system prompt.
      if (
        messages.some((m) => /compacting a coding session/i.test(m.content))
      ) {
        compactions += 1;

        return { content: "summary of the conversation", toolCalls: [] };
      }

      calls += 1;

      if (calls === 1) {
        throw new Error(
          "model request failed: 400 This model's maximum context length is 1000 tokens. However, you requested 1200 tokens."
        );
      }

      return { content: "recovered answer", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      // History >2 messages so the recovery path engages (a 2-message overflow
      // can't be compacted away).
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });

    const result = await session.send("hello");

    expect(result.status).not.toBe("stuck");
    expect(calls).toBe(2);
    expect(compactions).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a non-overflow provider error still ends the send as stuck (not swallowed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-sess-err-"));

  const provider: IProvider = {
    async complete() {
      throw new Error("model request failed: 401 invalid api key");
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    });

    const result = await session.send("hello");

    expect(result.status).toBe("stuck");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// ── C5: --continue seeds the auto-compaction gauge ───────────────────────────
test("a resumed near-full transcript compacts BEFORE the first call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-sess-seed-"));

  let compactions = 0;
  let mainCalls = 0;
  const provider: IProvider = {
    async complete(messages: readonly IChatMessage[]) {
      if (
        messages.some((m) => /compacting a coding session/i.test(m.content))
      ) {
        compactions += 1;

        return { content: "summary", toolCalls: [] };
      }

      mainCalls += 1;

      return { content: "ok", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      contextWindow: 10_000,
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
      // The persisted session recorded a 95%-full prompt.
      lastPromptTokens: 9_500,
    });

    await session.send("continue the work");

    // Proactive compaction fired from the SEEDED gauge before the first real
    // call — previously lastUsage was undefined until a call completed, so the
    // first resumed send always fired at full size.
    expect(compactions).toBeGreaterThanOrEqual(1);
    expect(mainCalls).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// ── C3: checklist revision survives resume ───────────────────────────────────
test("checklistRevision seeds from the highest revision in resumed history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-sess-rev-"));
  const { savePlan } = await import("../src/loop/worklist/checklist-store");

  savePlan(dir, {
    schemaVersion: 2,
    id: "plan-1",
    goal: "Build it",
    activeItemId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [{ id: "a", title: "Do the thing", status: "pending" }],
  });

  let pendingDone = false;
  const provider: IProvider = {
    async complete() {
      if (!pendingDone) {
        pendingDone = true;

        return {
          content: "",
          toolCalls: [
            { id: "1", name: "task_complete", arguments: { id: "a" } },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      accept: "true",
      activePlanId: "plan-1",
      maxTurns: 4,
      history: [
        { role: "system", content: "sys" },
        // A snapshot from the PREVIOUS process, stamped revision 4.
        {
          role: "user",
          content: "CHECKLIST (revision 4)\ngoal: Build it\n… tree …",
        },
      ],
    });

    await session.send("finish the plan");

    // The first change after resume must stamp a revision ABOVE every revision
    // already in history — previously the counter restarted at 0 and stamped
    // "revision 1", directing the model (via the freshness rule) at the stale
    // revision-4 tree.
    const stamps = session.messages
      .flatMap((m) => [...m.content.matchAll(/\(revision (\d+)\)/g)])
      .map((m) => Number(m[1]));
    const newest = Math.max(...stamps);

    expect(newest).toBeGreaterThan(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
