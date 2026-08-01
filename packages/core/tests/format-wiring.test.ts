import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";

/** A provider that never edits — Session.create only needs it to construct; these tests
 *  read the wiring, they don't drive a turn. */
const idleProvider: IProvider = {
  async complete(_messages: IChatMessage[]) {
    return { content: "done", toolCalls: [] };
  },
};

// The scoped format janitor depends on Session.create propagating cfg.coreFormat into
// the loop's gate context. The interactive CLI (and its /clear rebuild) pass
// coreFormat:true through this exact path — a regression in the session.ts spread would
// silently disable formatting for real sessions. This proves the propagation directly,
// without hand-constructing a loop context.
test("Session.create threads cfg.coreFormat=true into the gate context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-coreformat-"));

  try {
    const s = await Session.create({
      provider: idleProvider,
      cwd: dir,
      files: ["**/*"],
      coreFormat: true,
    });

    expect(s.coreFormat).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Session.create leaves the janitor OFF when cfg.coreFormat is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-coreformat-"));

  try {
    const s = await Session.create({
      provider: idleProvider,
      cwd: dir,
      files: ["**/*"],
    });

    expect(s.coreFormat).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
