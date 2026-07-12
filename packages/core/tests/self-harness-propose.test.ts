import { test, expect, describe } from "bun:test";
import { propose } from "../src/self-harness/propose";
import { emptyOverlay } from "../src/self-harness/overlay";
import type {
  IEvidenceBundle,
  IFailurePattern,
} from "../src/self-harness/self-harness.types";
import type { IChatMessage, IModelResponse, IProvider } from "../src/inference";

function pattern(partial: Partial<IFailurePattern>): IFailurePattern {
  return {
    signature: "type-error|none|TS2532",
    failureClass: "type-error",
    dominantSignal: "none",
    support: 2,
    taskIds: ["slugify", "math"],
    verifierEvidence: ["TS2532"],
    traceSnippets: ["gate: red (2 errors)"],
    mechanism: "Gate errors persisted.",
    ...partial,
  };
}

function bundle(patterns: IFailurePattern[]): IEvidenceBundle {
  return {
    totalRuns: 8,
    failedRuns: patterns.length,
    slowGreenRuns: 0,
    patterns,
  };
}

/** A provider that replays canned responses and records what it was asked. */
function scriptedProvider(responses: string[]): {
  provider: IProvider;
  prompts: IChatMessage[][];
} {
  const prompts: IChatMessage[][] = [];
  let i = 0;

  return {
    prompts,
    provider: {
      complete: (messages: IChatMessage[]): Promise<IModelResponse> => {
        prompts.push(messages);

        const content = responses[i] ?? "{}";

        i += 1;

        return Promise.resolve({ content, toolCalls: [] });
      },
    },
  };
}

const VALID_RESPONSE = JSON.stringify({
  targetPattern: "type-error|none|TS2532",
  surface: "procedureCards",
  expectedEffect: "Guides the model to guard index access before use.",
  risks: "Slightly longer repair feedback.",
  patch: {
    procedureCards: {
      TS2532: {
        procedure: "1) Bind the access to a const. 2) Guard for undefined.",
      },
    },
  },
});

describe("propose", () => {
  test("parses a valid response into a candidate with audit record", async () => {
    const { provider } = scriptedProvider([VALID_RESPONSE]);
    const notes: string[] = [];
    const candidates = await propose(bundle([pattern({})]), {
      provider,
      width: 1,
      current: emptyOverlay(),
      idPrefix: "r1",
      notes,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("r1-c1");
    expect(candidates[0]?.audit.targetPattern).toBe("type-error|none|TS2532");
    expect(candidates[0]?.patch.procedureCards?.TS2532?.procedure).toContain(
      "Guard for undefined"
    );
    expect(notes).toEqual([]);
  });

  test("a malformed proposal is salvaged by one re-ask showing the parse error", async () => {
    const { provider, prompts } = scriptedProvider([
      "not json at all", // first attempt: garbage
      VALID_RESPONSE, // salvage re-ask: corrected
    ]);
    const notes: string[] = [];
    const candidates = await propose(bundle([pattern({})]), {
      provider,
      width: 1,
      current: emptyOverlay(),
      notes,
    });

    expect(candidates).toHaveLength(1);
    expect(notes).toEqual([]);

    // the re-ask shows the model its own reply + the reason it was unusable
    const salvage = prompts[1] ?? [];

    expect(salvage.some((m) => m.role === "assistant")).toBe(true);
    expect(
      salvage.some((m) => m.role === "user" && m.content.includes("unusable"))
    ).toBe(true);
  });

  test("persistently malformed proposals drop with a salvage note — never throw", async () => {
    const oversize = JSON.stringify({
      targetPattern: "x",
      surface: "promptBlocks",
      expectedEffect: "too much",
      risks: "sprawl",
      patch: {
        promptBlocks: {
          bootstrap: { mode: "append", text: "a" },
          execution: { mode: "append", text: "b" },
          verification: { mode: "append", text: "c" },
          extra: { mode: "append", text: "d" },
        },
      },
    });
    const { provider } = scriptedProvider([
      "not json at all",
      "still not json", // salvage also fails
      oversize,
      oversize, // salvage repeats the oversize patch
    ]);
    const notes: string[] = [];
    const candidates = await propose(bundle([pattern({})]), {
      provider,
      width: 2,
      current: emptyOverlay(),
      notes,
    });

    expect(candidates).toHaveLength(0);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("after salvage re-ask");
    expect(notes[0]).toContain("unparseable");
    expect(notes[1]).toContain("minimality cap");
  });

  test("an invalid patch entry drops at validation, not at runtime", async () => {
    const sneaky = JSON.stringify({
      targetPattern: "x",
      surface: "ttsrRules",
      expectedEffect: "hijack",
      risks: "none",
      patch: {
        // missing guidance → rule drops → patch becomes empty → rejected
        ttsrRules: [{ name: "bad-rule", condition: ["x"] }],
      },
    });
    const { provider } = scriptedProvider([sneaky, sneaky]);
    const notes: string[] = [];
    const candidates = await propose(bundle([pattern({})]), {
      provider,
      width: 1,
      current: emptyOverlay(),
      notes,
    });

    expect(candidates).toEqual([]);
    expect(notes[0]).toContain("no editable surface");
  });

  test("later calls see earlier candidates (diversity context)", async () => {
    const { provider, prompts } = scriptedProvider([
      VALID_RESPONSE,
      VALID_RESPONSE,
    ]);

    await propose(bundle([pattern({})]), {
      provider,
      width: 2,
      current: emptyOverlay(),
    });

    const secondUser = prompts[1]?.find((m) => m.role === "user")?.content;

    expect(secondUser).toContain("already proposed THIS round");
    expect(secondUser).toContain("procedureCards");
  });

  test("empty bundle short-circuits; overflow patterns are noted, not silent", async () => {
    const notes: string[] = [];
    const { provider, prompts } = scriptedProvider([]);

    expect(
      await propose(bundle([]), {
        provider,
        width: 3,
        current: emptyOverlay(),
        notes,
      })
    ).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(notes[0]).toContain("no failure patterns");

    const many = Array.from({ length: 7 }, (_, i) =>
      pattern({ signature: `sig-${String(i)}` })
    );
    const scripted = scriptedProvider([VALID_RESPONSE]);
    const overflowNotes: string[] = [];

    await propose(bundle(many), {
      provider: scripted.provider,
      width: 1,
      current: emptyOverlay(),
      notes: overflowNotes,
    });

    expect(overflowNotes.some((n) => n.includes("dropped 2 low-support"))).toBe(
      true
    );
  });

  test("held-out task ids never appear in the proposer context", async () => {
    const { provider, prompts } = scriptedProvider([VALID_RESPONSE]);

    await propose(bundle([pattern({ taskIds: ["slugify"] })]), {
      provider,
      width: 1,
      current: emptyOverlay(),
    });

    const user = prompts[0]?.find((m) => m.role === "user")?.content ?? "";

    // The context contains only what the bundle carries — held-in evidence.
    expect(user).toContain("slugify");
    expect(user).not.toContain("held-out");
  });
});
