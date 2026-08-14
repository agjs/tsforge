import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IChatMessage, IProvider } from "../src/inference";
import { Session } from "../src/loop";
import {
  compactConversation,
  HARNESS_ARGS_OMITTED,
  looksLikeHarnessOmitMarker,
  MAX_LIVE_READ_PATHS,
  pruneEphemeralToolResidue,
  scrubLegacyWriteArgStubs,
  upsertGateFeedback,
} from "../src/loop/context-hygiene";
import { isGateFeedbackInject } from "../src/loop/harness-inject";
import {
  injectFeedback,
  type ILoopCtx,
  type ILoopState,
} from "../src/loop/turn";
import type { IErrorItem, IValidateResult } from "../src/validate";

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    bestErrorCount: Number.POSITIVE_INFINITY,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
    steerLevel: 0,
  };
}

function makeInjectCtx(messages: IChatMessage[]): ILoopCtx {
  return {
    task: { id: "t", intent: "test", accept: "", files: ["**/*"], context: [] },
    cwd: process.cwd(),
    tsService: null,
    report: () => undefined,
    messages,
    tool: { touched: new Set<string>() },
    gate: {
      parse: undefined,
      runner: {
        run: async (): Promise<IValidateResult> => ({
          passed: true,
          errors: [],
          output: "",
        }),
      },
    },
  };
}

describe("isGateFeedbackInject", () => {
  test("flags bare and NEAR-GREEN-wrapped acceptance walls", () => {
    expect(
      isGateFeedbackInject({
        role: "user",
        content:
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      })
    ).toBe(true);
    expect(
      isGateFeedbackInject({
        role: "user",
        content:
          "⚠ NEAR-GREEN — only 1 error(s) from done.\n\n" +
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      })
    ).toBe(true);
    expect(
      isGateFeedbackInject({
        role: "user",
        content: "Build a notes CLI",
      })
    ).toBe(false);
  });
});

describe("gate feedback is append-only, deduped at compaction", () => {
  test("two red settles append; the newest is last and the prefix is untouched", async () => {
    const messages: IChatMessage[] = [];
    const ctx = makeInjectCtx(messages);
    const state = freshState();

    const err: IErrorItem = {
      key: "a.ts:1:x",
      file: "a.ts",
      message: "L1: boom",
    };

    await injectFeedback(ctx, state, [err], [], []);
    messages.push({
      role: "assistant",
      content: "trying again",
      toolCalls: [],
    });
    await injectFeedback(
      ctx,
      state,
      [{ ...err, message: "L1: boom2" }],
      [],
      []
    );

    const gates = messages.filter((m) => isGateFeedbackInject(m));

    // Replacing the older slot IN PLACE rewrote the prompt from that point and
    // discarded the server's prefix cache: measured at 13 calls of 116-168s in
    // one 146-turn run. Appending keeps every earlier message byte-identical.
    expect(gates).toHaveLength(2);
    expect(gates.at(-1)?.content).toContain("boom2");
    expect(messages.at(-1)?.content).toContain("boom2");
    // The first feedback and the assistant turn after it are still where they were.
    expect(messages[0]?.content).toContain("boom");
    expect(messages[1]?.content).toBe("trying again");
  });

  test("injectFeedback prepends harness attribution from lastFailureClass", async () => {
    const messages: IChatMessage[] = [];
    const ctx = makeInjectCtx(messages);
    const state = freshState();

    state.lastFailureClass = "lint-rule";
    state.lastFailureDetail = "no-process-exit";

    const err: IErrorItem = {
      key: "k",
      message: "process.exit forbidden",
      rule: "no-process-exit",
      file: "src/api.ts",
    };

    await injectFeedback(ctx, state, [err], [], []);

    const wall = messages.find((m) => m.role === "user")?.content ?? "";

    expect(wall).toContain("Harness attribution: lint-rule (no-process-exit)");
    expect(wall).toContain("The acceptance command still fails:");
    expect(wall).toContain("do not disable");
  });

  test("upsert appends rather than rewriting an earlier slot", () => {
    const messages: IChatMessage[] = [
      {
        role: "user",
        content:
          "The acceptance command still fails:\n- old\n\nFix your editable files and run it again.",
      },
      { role: "assistant", content: "ok" },
    ];

    upsertGateFeedback(
      messages,
      "The acceptance command still fails:\n- new\n\nFix your editable files and run it again."
    );

    const gates = messages.filter((m) => isGateFeedbackInject(m));

    expect(gates).toHaveLength(2);
    expect(gates.at(-1)?.content).toContain("- new");
    // The old copy SURVIVES until compaction — rewriting it in place is exactly
    // what cost the prefix cache. Position 0 must be byte-identical.
    expect(messages[0]?.content).toContain("- old");
    expect(messages.at(-1)?.content).toContain("- new");
  });

  test("compaction leaves exactly one gate feedback — the newest", async () => {
    const provider: IProvider = {
      async complete() {
        return { content: "summary", toolCalls: [] };
      },
    };
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "U".repeat(50_000) },
      {
        role: "user",
        content:
          "The acceptance command still fails:\n- old\n\nFix your editable files and run it again.",
      },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content:
          "The acceptance command still fails:\n- new\n\nFix your editable files and run it again.",
      },
    ];

    const result = await compactConversation(messages, provider);
    const gates = result.messages.filter((m) => isGateFeedbackInject(m));

    expect(gates.length).toBeLessThanOrEqual(1);

    if (gates.length === 1) {
      expect(gates[0]?.content).toContain("- new");
    }
  });
});

describe("scrubLegacyWriteArgStubs", () => {
  test("rewrites persisted contentMeta stubs so --continue cannot revive them", () => {
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "create",
            arguments: {
              file: "a.ts",
              contentMeta: { omitted: true, bytes: 9, sha256: "deadbeefcafe" },
            },
          },
        ],
      },
    ];

    expect(scrubLegacyWriteArgStubs(messages)).toBe(1);
    expect(messages[0]?.toolCalls?.[0]?.arguments).toEqual({
      file: "a.ts",
      [HARNESS_ARGS_OMITTED]: true,
    });
    expect(JSON.stringify(messages)).not.toMatch(/contentMeta/u);
  });
});

describe("looksLikeHarnessOmitMarker", () => {
  test("flags every marker shape DeepSeek copied onto disk", () => {
    expect(
      looksLikeHarnessOmitMarker(
        '<harness:content-omitted bytes="12" sha256="deadbeefcafe">'
      )
    ).toBe(true);
    expect(
      looksLikeHarnessOmitMarker(
        "[applied; on disk — THIS IS NOT FILE CONTENTS]"
      )
    ).toBe(true);
    expect(looksLikeHarnessOmitMarker("export const x = 1;\n")).toBe(false);
  });
});

describe("pruneEphemeralToolResidue", () => {
  test("unique survey reads survive many later assistant turns", () => {
    // Shiphold trap: age-based omit after 2 turns wiped A/B while surveying C,
    // then stub said "call read again" → deadlock.
    const messages: IChatMessage[] = [];

    for (const [id, file, body] of [
      ["r1", "a.ts", "export const a = 1;\n"],
      ["r2", "b.ts", "export const b = 2;\n"],
      ["r3", "c.ts", "export const c = 3;\n"],
    ] as const) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id, name: "read", arguments: { file } }],
        },
        { role: "tool", toolCallId: id, content: `${file}\n${body}` }
      );
    }

    for (let i = 0; i < 6; i += 1) {
      messages.push({ role: "assistant", content: `turn ${String(i)}` });
    }

    pruneEphemeralToolResidue(messages);

    const tools = messages.filter((m) => m.role === "tool");

    expect(tools).toHaveLength(3);

    for (const tool of tools) {
      expect(tool.content.includes("harness:read-omitted")).toBe(false);
      expect(tool.content).toMatch(/export const [abc]/u);
    }
  });

  test("re-read of same path supersedes older dump — never invites read again", () => {
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "r1", name: "read", arguments: { file: "types.ts" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "r1",
        content: "types.ts\nOLD_SHAPE\n",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "r2", name: "read", arguments: { file: "types.ts" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "r2",
        content: "types.ts\nNEW_SHAPE\n",
      },
    ];

    pruneEphemeralToolResidue(messages);

    const older = messages.find(
      (m) => m.role === "tool" && m.toolCallId === "r1"
    );
    const newer = messages.find(
      (m) => m.role === "tool" && m.toolCallId === "r2"
    );

    expect(older?.content).toContain("harness:read-omitted");
    expect(older?.content).toContain("superseded");
    expect(older?.content).toContain("do NOT call read again");
    expect(older?.content).not.toContain("if you need the source");
    expect(newer?.content).toContain("NEW_SHAPE");
    expect(newer?.content.includes("harness:read-omitted")).toBe(false);
  });

  test("over MAX_LIVE_READ_PATHS unique reads drop oldest without re-read invite", () => {
    const messages: IChatMessage[] = [];

    for (let i = 0; i < MAX_LIVE_READ_PATHS + 2; i += 1) {
      const id = `r${String(i)}`;
      const file = `f${String(i)}.ts`;

      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id, name: "read", arguments: { file } }],
        },
        {
          role: "tool",
          toolCallId: id,
          content: `${file}\nBODY_${String(i)}\n`,
        }
      );
    }

    pruneEphemeralToolResidue(messages);

    const tools = messages.filter((m) => m.role === "tool");
    const live = tools.filter(
      (m) => !m.content.includes("harness:read-omitted")
    );
    const omitted = tools.filter((m) =>
      m.content.includes("harness:read-omitted")
    );

    expect(live).toHaveLength(MAX_LIVE_READ_PATHS);
    expect(omitted).toHaveLength(2);
    // Oldest two paths (f0, f1) are budget-dropped.
    expect(omitted.some((m) => m.content.includes('path="f0.ts"'))).toBe(true);
    expect(omitted.some((m) => m.content.includes('path="f1.ts"'))).toBe(true);

    for (const m of omitted) {
      expect(m.content).toContain("context size");
      expect(m.content).toContain("do NOT call read again");
      expect(m.content).not.toContain("if you need the source");
    }

    // Newest paths still live.
    expect(
      tools.find((m) => m.toolCallId === `r${String(MAX_LIVE_READ_PATHS + 1)}`)
        ?.content
    ).toContain(`BODY_${String(MAX_LIVE_READ_PATHS + 1)}`);
  });

  test("looksLikeHarnessOmitMarker catches read-omitted stubs", () => {
    expect(
      looksLikeHarnessOmitMarker(
        '<harness:read-omitted path="x.ts" — NOT file contents; do NOT call read again>'
      )
    ).toBe(true);
  });

  test("create/edit args stay full after later assistant turns", () => {
    const body = "export const x = 1;\n";
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "create",
            arguments: { file: "x.ts", content: body },
          },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "created x.ts" },
    ];

    pruneEphemeralToolResidue(messages);
    expect(messages[0]?.toolCalls?.[0]?.arguments.content).toBe(body);

    messages.push({ role: "assistant", content: "next" });
    pruneEphemeralToolResidue(messages);

    const args = messages[0]?.toolCalls?.[0]?.arguments;

    expect(args).toEqual({ file: "x.ts", content: body });
    expect(JSON.stringify(args)).not.toMatch(
      /contentMeta|_harnessArgsOmitted/u
    );
  });

  test("edit args stay full — never collapse to omit stubs", () => {
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "e1",
            name: "edit",
            arguments: {
              file: "a.ts",
              oldString: "const x = 1;",
              newString: "const x = 2;",
            },
          },
        ],
      },
      { role: "tool", toolCallId: "e1", content: "edited a.ts" },
      { role: "assistant", content: "next" },
    ];

    pruneEphemeralToolResidue(messages);

    const args = messages[0]?.toolCalls?.[0]?.arguments;

    expect(args).toEqual({
      file: "a.ts",
      oldString: "const x = 1;",
      newString: "const x = 2;",
    });
    expect(JSON.stringify(args)).not.toMatch(
      /oldStringMeta|newStringMeta|contentMeta|_harnessArgsOmitted/u
    );
  });

  test("edits[] stay full after later assistant turns", () => {
    const edits = [
      { oldString: "a", newString: "b" },
      { oldString: "c", newString: "d" },
    ];
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "e2",
            name: "edit",
            arguments: {
              file: "a.ts",
              edits,
            },
          },
        ],
      },
      { role: "tool", toolCallId: "e2", content: "edited a.ts" },
      { role: "assistant", content: "next" },
    ];

    pruneEphemeralToolResidue(messages);

    const args = messages[0]?.toolCalls?.[0]?.arguments;

    expect(args).toEqual({ file: "a.ts", edits });
  });

  test("write-guard blast collapses once a later gate feedback exists", () => {
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "create",
            arguments: { file: "a.ts", content: "x" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content:
          "created a.ts\n\n⚠ CHECK of this file found 12 issue(s) — fix them now\n  L1: boom",
      },
      {
        role: "user",
        content:
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      },
    ];

    pruneEphemeralToolResidue(messages);

    const tool = messages.find((m) => m.role === "tool");

    expect(tool?.content).toContain("created a.ts");
    expect(tool?.content).toContain("write-guard detail dropped");
    expect(tool?.content.includes("L1: boom")).toBe(false);
  });

  test("write-guard blast ages after a later assistant turn (no gate needed)", () => {
    const messages: IChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "create",
            arguments: { file: "a.ts", content: "x" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content:
          "created a.ts\n\nℹ a.ts auto-formatted — CURRENT content (use this for oldString):\n1| x\n",
      },
    ];

    pruneEphemeralToolResidue(messages);
    expect(messages[1]?.content).toContain("CURRENT content");

    messages.push({ role: "assistant", content: "next" });
    pruneEphemeralToolResidue(messages);

    expect(messages[1]?.content).toContain("created a.ts");
    expect(messages[1]?.content).toContain("write-guard detail dropped");
    expect(messages[1]?.content.includes("CURRENT content")).toBe(false);
  });
});

describe("assistantMessage clones tool args for history", () => {
  test("prune cannot poison a reused scripted create step", async () => {
    const { assistantMessage } = await import("../src/loop/assistant-message");
    const step = {
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "create",
          arguments: { file: "calc.ts", content: "export const n = 1;\n" },
        },
      ],
    };
    const messages: IChatMessage[] = [assistantMessage(step)];

    messages.push({ role: "assistant", content: "next" });
    pruneEphemeralToolResidue(messages);

    // Args stay full in history — still cloned so hygiene cannot share refs.
    expect(messages[0]?.toolCalls?.[0]?.arguments).toEqual({
      file: "calc.ts",
      content: "export const n = 1;\n",
    });
    expect(step.toolCalls[0]?.arguments).toEqual({
      file: "calc.ts",
      content: "export const n = 1;\n",
    });
    expect(messages[0]?.toolCalls?.[0]?.arguments).not.toBe(
      step.toolCalls[0]?.arguments
    );
  });
});

describe("headless mid-drive compact wiring", () => {
  test("compactConversation replaces history with system + summary + retained tail", async () => {
    const provider: IProvider = {
      async complete() {
        return { content: "brief summary", toolCalls: [] };
      },
    };
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    const result = await compactConversation(messages, provider);

    expect(result.before).toBe(3);
    expect(result.after).toBe(3);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.content).toContain("brief summary");
    // The newest turn survives the compact verbatim — that is the point of it.
    expect(result.messages[2]?.content).toBe("world");
  });
});

describe("Session create keeps applied toolCall bodies", () => {
  test("after create applies, history toolCall args still carry content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-redact-"));
    const body = "export const notes = [];\n".repeat(30);
    let phase = 0;
    const provider: IProvider = {
      async complete() {
        phase += 1;

        if (phase === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "c1",
                name: "create",
                arguments: { file: "notes.ts", content: body },
              },
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
        maxTurns: 4,
      });

      await session.send("write notes");

      const createCall = session.messages
        .flatMap((m) => m.toolCalls ?? [])
        .find((tc) => tc.name === "create");

      expect(createCall).toBeDefined();
      expect(createCall?.arguments).toEqual({
        file: "notes.ts",
        content: body,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
