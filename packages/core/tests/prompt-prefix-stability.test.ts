import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import {
  recordingScripted,
  runStep,
  STOP,
  type ISentPrefix,
} from "./stub-provider";

/**
 * THE PROMPT PREFIX MUST NOT MOVE MID-RUN.
 *
 * Every cycle re-sends the whole conversation. A local vLLM serves a
 * byte-identical leading prefix from its cache and re-processes everything from
 * the first differing byte onward, so anything that varies per turn near the
 * front of the request — a count folded into the system prompt, a topic list
 * baked into a tool schema, a timestamp — turns every later cycle into a full
 * prefill. The build still goes green, just progressively more expensively, and
 * the symptom is indistinguishable from a slow model.
 *
 * Nothing enforced that today. The prefix happens to be stable because `run.ts`
 * builds the system prompt and the tool array once before the loop, but a future
 * edit could fold per-cycle state into either without a single test objecting.
 * These are that objection.
 *
 * Per-turn context is supposed to ride the TAIL — appended gate errors, steers,
 * pushed guides — which is why only the head is asserted here.
 */
async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-prefix-"));
}

/** Drive a multi-turn run and return what each call actually sent. */
async function sentPrefixes(steps: number): Promise<ISentPrefix[]> {
  const dir = await tmp();

  try {
    const sent: ISentPrefix[] = [];
    // Several real working turns, then stop → gate → green. Each turn is a
    // separate model call, which is what makes the comparison meaningful.
    const script = [
      ...Array.from({ length: steps }, () => runStep("echo working")),
      runStep("echo x > fixed.txt"),
      STOP,
    ];

    await runTask(
      { id: "1", accept: "test -f fixed.txt", files: [] },
      dir,
      recordingScripted(script, sent),
      { onEvent: () => undefined }
    );

    return sent;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("prompt prefix stability across a run", () => {
  test("the system prompt is byte-identical on every call", async () => {
    const sent = await sentPrefixes(4);

    expect(sent.length).toBeGreaterThan(3);

    const first = sent[0]?.system ?? "";

    expect(first.length).toBeGreaterThan(0);

    for (const [i, call] of sent.entries()) {
      // Byte equality, not "close enough": the server's cache lookup is a
      // prefix hash, so one differing character costs the whole prefill.
      expect(
        call.system,
        `call ${String(i + 1)} changed the system prompt`
      ).toBe(first);
    }
  });

  test("the advertised tool array is byte-identical on every call", async () => {
    const sent = await sentPrefixes(4);
    const first = sent[0]?.tools ?? "";

    expect(first.length).toBeGreaterThan(2);

    for (const [i, call] of sent.entries()) {
      // Includes ORDER. A reordered tool array serializes differently and
      // therefore hashes differently, even though its contents are the same —
      // which is why this compares the serialized form and not the structure.
      expect(call.tools, `call ${String(i + 1)} changed the tool schema`).toBe(
        first
      );
    }
  });

  test("the original task request is byte-identical on every call", async () => {
    // The seed request is part of the cache-stable head too: the loop appends
    // per-turn context after it, never rewrites it in place.
    const sent = await sentPrefixes(4);
    const first = sent[0]?.firstUser ?? "";

    expect(first.length).toBeGreaterThan(0);

    for (const [i, call] of sent.entries()) {
      expect(
        call.firstUser,
        `call ${String(i + 1)} changed the seed request`
      ).toBe(first);
    }
  });
});
