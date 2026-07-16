import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import { MEMORY_RUN_ID } from "../src/loop/session";

describe("Session memory source id (learned-rule self-poisoning guard)", () => {
  test("every send in one build consolidates under the SAME stable source id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-sess-mem-"));

    try {
      // A provider that just yields — enough to drive a send to completion so the
      // post-send memory hook runs.
      const provider: IProvider = {
        complete: () => Promise.resolve({ content: "done", toolCalls: [] }),
      };

      // Capture the source id passed to consolidation on each send (the seam
      // defaults to the real memory pipeline in production).
      const sources: string[] = [];
      const session = await Session.create({
        provider,
        cwd: dir,
        files: ["**/*"],
        consolidateLessons: (_cwd, _cands, source) => {
          sources.push(source);

          return Promise.resolve(0);
        },
      });

      await session.send("first send");
      await session.send("second send");

      // The whole point of the fix: two sends of ONE build share ONE source id.
      // The old code recomputed `session-${Date.now()}` per send, so reverting
      // it pushes two DIFFERENT ids here — this asserts the shared constant.
      expect(sources).toHaveLength(2);
      expect(sources[0]).toBe(MEMORY_RUN_ID);
      expect(sources[1]).toBe(MEMORY_RUN_ID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
