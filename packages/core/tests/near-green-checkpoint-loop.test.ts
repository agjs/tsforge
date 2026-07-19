import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { IGate } from "../src/gate/gate-runner";

// WS-B end-to-end: with the flag ON, a build that reaches near-green (1 error) then SPRAYS
// (8 errors) must REVERT the scope files to the near-green best; with the flag OFF the path
// is unchanged (no revert). Driven through the real settleGate integration.

const FLAG = "TSFORGE_NEAR_GREEN_CHECKPOINT";

afterEach(() => {
  delete process.env.TSFORGE_NEAR_GREEN_CHECKPOINT;
});

/** A gate whose error count depends on the file the model wrote: content with "BAD" = an
 *  8-error spray; anything else = the 1-error near-green state. Never green, so the drive
 *  runs long enough to checkpoint then spray. */
function contentAwareGate(dir: string): IGate {
  return {
    run: async () => {
      let content: string;

      try {
        content = await Bun.file(join(dir, "feature.ts")).text();
      } catch {
        content = "";
      }

      const n = content.includes("BAD") ? 8 : 1;

      return {
        passed: false,
        errors: Array.from({ length: n }, (_, i) => ({
          key: `e${String(i)}`,
          message: `error ${String(i)}`,
        })),
        output: `${String(n)} error(s)`,
      };
    },
  };
}

/** Writes the near-green file, yields to gate it, sprays a BAD file, yields to gate it,
 *  then just yields — so after any revert no further BAD edit re-dirties the tree. */
function nearGreenThenSpray(): IProvider {
  let n = 0;

  return {
    async complete() {
      n += 1;

      if (n === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "create",
              arguments: {
                file: "feature.ts",
                content: "export const GOOD = 1;\n",
              },
            },
          ],
        };
      }

      if (n === 3) {
        // `create` won't overwrite a parseable file — edit the near-green file into the
        // spray state instead (GOOD → BAD).
        return {
          content: "",
          toolCalls: [
            {
              id: "c2",
              name: "edit",
              arguments: {
                file: "feature.ts",
                oldString: "GOOD",
                newString: "BAD",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };
}

test("flag ON: a spray past the near-green checkpoint REVERTS the file to the best state", async () => {
  process.env[FLAG] = "1";
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: nearGreenThenSpray(),
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // The rollback fired (a distinctive tool event) …
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(true);
    // … and the on-disk file was restored to the near-green best — the spray is gone.
    const final = await Bun.file(join(dir, "feature.ts")).text();

    expect(final).toContain("GOOD");
    expect(final).not.toContain("BAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("flag OFF (default): the SAME spray is NOT reverted — no path change", async () => {
  // FLAG unset → default off.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: nearGreenThenSpray(),
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // No rollback event, and the sprayed file was left as the model wrote it (BAD).
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(false);
    const final = await Bun.file(join(dir, "feature.ts")).text();

    expect(final).toContain("BAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
