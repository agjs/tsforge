import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyOverlay,
  parseOverlay,
  mergeOverlay,
  isEmptyPatch,
  modelSlug,
  overlayPathFor,
  activeOverlay,
  resetOverlayCache,
} from "../src/self-harness/overlay";
import type { IOverlayPatch } from "../src/self-harness/self-harness.types";

const SAVED_ENV = {
  overlay: process.env.TSFORGE_SELF_HARNESS_OVERLAY,
  home: process.env.TSFORGE_HOME,
  model: process.env.TSFORGE_MODEL,
};

function restoreVar(name: "overlay" | "home" | "model"): void {
  const value = SAVED_ENV[name];

  if (value !== undefined) {
    if (name === "overlay") {
      process.env.TSFORGE_SELF_HARNESS_OVERLAY = value;
    } else if (name === "home") {
      process.env.TSFORGE_HOME = value;
    } else {
      process.env.TSFORGE_MODEL = value;
    }
  }
}

function restoreEnv(): void {
  delete process.env.TSFORGE_SELF_HARNESS_OVERLAY;
  delete process.env.TSFORGE_HOME;
  delete process.env.TSFORGE_MODEL;
  restoreVar("overlay");
  restoreVar("home");
  restoreVar("model");
  resetOverlayCache();
}

afterEach(restoreEnv);

describe("parseOverlay", () => {
  test("accepts a well-formed overlay and validates every surface", () => {
    const overlay = parseOverlay({
      version: 1,
      ttsrRules: [
        {
          name: "loop-breaker",
          condition: ["stuck in a loop"],
          scope: "content",
          guidance: "Stop repeating; pick the smallest next step.",
          repeatMode: "cooldown",
          repeatGap: 5,
        },
      ],
      agentSpecOverrides: [{ id: "explore", maxTurns: 20 }],
      promptBlocks: {
        bootstrap: { mode: "append", text: "Create the output file early." },
      },
      procedureCards: {
        TS2307: { procedure: "1) Check the import path exists on disk." },
      },
    });

    expect(overlay).not.toBeNull();
    expect(overlay?.ttsrRules).toHaveLength(1);
    expect(overlay?.ttsrRules[0]?.name).toBe("loop-breaker");
    expect(overlay?.agentSpecOverrides).toEqual([
      { id: "explore", maxTurns: 20 },
    ]);
    expect(overlay?.promptBlocks.bootstrap?.mode).toBe("append");
    expect(overlay?.procedureCards.TS2307?.procedure).toContain("import path");
  });

  test("drops invalid entries per-surface instead of failing the overlay", () => {
    const overlay = parseOverlay({
      ttsrRules: [{ name: "no-guidance", condition: ["x"] }], // missing guidance
      agentSpecOverrides: [{ maxTurns: 5 }, { id: "verify", maxTurns: -1 }],
      promptBlocks: {
        "not-a-block": { mode: "append", text: "hi" },
        execution: { mode: "sideways", text: "hi" },
        verification: { mode: "replace", text: "" },
      },
      procedureCards: { TS2532: { what: 42 }, "no-as": "not-an-object" },
    });

    expect(overlay).not.toBeNull();
    expect(overlay?.ttsrRules).toEqual([]);
    // the id-less override drops entirely; the bad maxTurns drops field-wise
    expect(overlay?.agentSpecOverrides).toEqual([{ id: "verify" }]);
    expect(overlay?.promptBlocks).toEqual({});
    expect(overlay?.procedureCards).toEqual({});
  });

  test("rejects a non-object and tolerates missing fields", () => {
    expect(parseOverlay("nope")).toBeNull();
    expect(parseOverlay(null)).toBeNull();
    expect(parseOverlay({})).toEqual(emptyOverlay());
  });
});

describe("mergeOverlay", () => {
  test("append edits to the same block compose; replace supersedes", () => {
    const base = mergeOverlay(emptyOverlay(), {
      promptBlocks: { bootstrap: { mode: "append", text: "A" } },
    });
    const appended = mergeOverlay(base, {
      promptBlocks: { bootstrap: { mode: "append", text: "B" } },
    });

    expect(appended.promptBlocks.bootstrap).toEqual({
      mode: "append",
      text: "A\nB",
    });

    const replaced = mergeOverlay(appended, {
      promptBlocks: { bootstrap: { mode: "replace", text: "C" } },
    });

    expect(replaced.promptBlocks.bootstrap).toEqual({
      mode: "replace",
      text: "C",
    });
  });

  test("re-merging the same append is idempotent (no duplicate stacking)", () => {
    // A campaign relaunch that reprocesses the same lineage used to append the
    // same learned text again and again, bloating the block with duplicates.
    const base = mergeOverlay(emptyOverlay(), {
      promptBlocks: { bootstrap: { mode: "append", text: "learned rule X" } },
    });
    const again = mergeOverlay(base, {
      promptBlocks: { bootstrap: { mode: "append", text: "learned rule X" } },
    });

    expect(again.promptBlocks.bootstrap?.text).toBe("learned rule X");
  });

  test("distinct appends still stack (learning accumulates)", () => {
    let overlay = emptyOverlay();

    for (const text of ["one", "two", "three"]) {
      overlay = mergeOverlay(overlay, {
        promptBlocks: { execution: { mode: "append", text } },
      });
    }

    expect(overlay.promptBlocks.execution?.text).toBe("one\ntwo\nthree");
  });

  test("append growth is bounded — a block never grows without limit", () => {
    let overlay = emptyOverlay();

    // Far more appends than the ceiling allows; each is distinct so dedup can't
    // hide the growth. The block must stay within a bounded size.
    for (let i = 0; i < 2000; i += 1) {
      overlay = mergeOverlay(overlay, {
        promptBlocks: {
          verification: { mode: "append", text: `distinct learned line ${i}` },
        },
      });
    }

    const len = overlay.promptBlocks.verification?.text.length ?? 0;

    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThanOrEqual(8000);
  });

  test("ttsr rules dedupe by name with the patch winning", () => {
    const base = mergeOverlay(emptyOverlay(), {
      ttsrRules: [
        {
          name: "r1",
          condition: ["old"],
          scope: "content",
          guidance: "old guidance",
          repeatMode: "once",
        },
      ],
    });
    const merged = mergeOverlay(base, {
      ttsrRules: [
        {
          name: "r1",
          condition: ["new"],
          scope: "content",
          guidance: "new guidance",
          repeatMode: "once",
        },
      ],
    });

    expect(merged.ttsrRules).toHaveLength(1);
    expect(merged.ttsrRules[0]?.guidance).toBe("new guidance");
  });

  test("agent overrides merge field-wise by id; cards merge per rule", () => {
    const base = mergeOverlay(emptyOverlay(), {
      agentSpecOverrides: [{ id: "explore", maxTurns: 10 }],
      procedureCards: { TS2307: { what: "module missing" } },
    });
    const merged = mergeOverlay(base, {
      agentSpecOverrides: [{ id: "explore", systemPrompt: "Be brief." }],
      procedureCards: { TS2307: { procedure: "check the path" } },
    });

    expect(merged.agentSpecOverrides).toEqual([
      { id: "explore", maxTurns: 10, systemPrompt: "Be brief." },
    ]);
    expect(merged.procedureCards.TS2307).toEqual({
      what: "module missing",
      procedure: "check the path",
    });
  });
});

describe("isEmptyPatch", () => {
  test("true only when no surface is touched", () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ ttsrRules: [], promptBlocks: {} })).toBe(true);
    expect(isEmptyPatch({ procedureCards: { TS2307: { what: "x" } } })).toBe(
      false
    );
  });
});

describe("modelSlug / overlayPathFor", () => {
  test("slugs a model id to a safe directory name", () => {
    expect(modelSlug("deepseek-ai/DeepSeek-V4-Flash")).toBe(
      "deepseek-ai-deepseek-v4-flash"
    );
    expect(modelSlug("///")).toBe("model");
  });

  test("path honors TSFORGE_HOME", () => {
    process.env.TSFORGE_HOME = "/custom/home";
    expect(overlayPathFor("m1")).toBe(
      "/custom/home/.tsforge/self-harness/m1/overlay.json"
    );
  });
});

describe("activeOverlay resolution", () => {
  test("env path wins and the cache resets when it changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sh-overlay-"));

    try {
      const path = join(dir, "candidate.json");

      await writeFile(
        path,
        JSON.stringify({
          promptBlocks: { extra: { mode: "append", text: "candidate edit" } },
        })
      );
      process.env.TSFORGE_SELF_HARNESS_OVERLAY = path;
      resetOverlayCache();

      expect(activeOverlay()?.promptBlocks.extra?.text).toBe("candidate edit");

      delete process.env.TSFORGE_SELF_HARNESS_OVERLAY;
      delete process.env.TSFORGE_MODEL;
      process.env.TSFORGE_HOME = dir; // no models.json here → no overlay
      resetOverlayCache();

      expect(activeOverlay()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the per-model promoted overlay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sh-overlay-"));

    try {
      process.env.TSFORGE_HOME = dir;
      process.env.TSFORGE_MODEL = "acme/Model-X";
      delete process.env.TSFORGE_SELF_HARNESS_OVERLAY;

      const promoted = overlayPathFor("acme/Model-X");

      await mkdir(join(dir, ".tsforge", "self-harness", "acme-model-x"), {
        recursive: true,
      });
      await writeFile(
        promoted,
        JSON.stringify({
          promptBlocks: { extra: { mode: "append", text: "promoted" } },
        })
      );
      resetOverlayCache();

      expect(activeOverlay()?.promptBlocks.extra?.text).toBe("promoted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed overlay file degrades to null, never a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sh-overlay-"));

    try {
      const path = join(dir, "broken.json");

      await writeFile(path, "{not json");
      process.env.TSFORGE_SELF_HARNESS_OVERLAY = path;
      resetOverlayCache();

      expect(activeOverlay()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("merge patch typing", () => {
  test("a full-surface patch merges onto the empty overlay", () => {
    const patch: IOverlayPatch = {
      ttsrRules: [
        {
          name: "verify-artifact",
          condition: ["task is complete"],
          scope: "content",
          guidance: "Verify the required artifact exists before concluding.",
          repeatMode: "once",
        },
      ],
      agentSpecOverrides: [{ id: "verify", task: "Check outputs exist." }],
      promptBlocks: { verification: { mode: "append", text: "Read it back." } },
      procedureCards: { "no-as": { procedure: "Type the parameter instead." } },
    };
    const merged = mergeOverlay(emptyOverlay(), patch);

    expect(merged.ttsrRules).toHaveLength(1);
    expect(merged.agentSpecOverrides).toHaveLength(1);
    expect(Object.keys(merged.promptBlocks)).toEqual(["verification"]);
    expect(Object.keys(merged.procedureCards)).toEqual(["no-as"]);
  });
});

describe("tool overrides", () => {
  afterEach(() => {
    restoreEnv();
    resetOverlayCache();
  });

  test("an installed overlay's tool edits reach the runtime", async () => {
    // The whole path: a file on disk → activeOverlay() → the value the session
    // hands to offeredToolsFor. Unit tests cover the filter itself; this pins
    // that a promoted overlay actually carries tool edits to the model call.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-tool-overlay-"));
    const path = join(dir, "overlay.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          toolOverrides: [
            { id: "read", description: "read a file; paths are relative" },
            { id: "run", enabled: false },
          ],
        })
      );
      process.env.TSFORGE_SELF_HARNESS_OVERLAY = path;
      resetOverlayCache();

      const overrides = activeOverlay()?.toolOverrides ?? [];

      expect(overrides).toHaveLength(2);
      expect(overrides[0]).toEqual({
        id: "read",
        description: "read a file; paths are relative",
      });
      expect(overrides[1]).toEqual({ id: "run", enabled: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a tool edit without an id is dropped, not carried half-formed", () => {
    const parsed = parseOverlay({
      version: 1,
      toolOverrides: [{ description: "no id here" }, { id: "read" }],
    });

    expect(parsed?.toolOverrides).toEqual([{ id: "read" }]);
  });

  test("a patch that only edits tools is not an empty patch", () => {
    // isEmptyPatch decides whether a candidate is rejected outright. Missing
    // the new surface here would silently discard every tool proposal.
    const patch: IOverlayPatch = { toolOverrides: [{ id: "read" }] };

    expect(isEmptyPatch(patch)).toBe(false);
  });

  test("tool edits merge by id, field-wise", () => {
    const base = mergeOverlay(emptyOverlay(), {
      toolOverrides: [{ id: "read", description: "first" }],
    });
    const merged = mergeOverlay(base, {
      toolOverrides: [{ id: "read", enabled: false }, { id: "edit" }],
    });

    expect(merged.toolOverrides).toEqual([
      { id: "read", description: "first", enabled: false },
      { id: "edit" },
    ]);
  });
});
