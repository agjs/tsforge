/**
 * Injection-point safety: with NO overlay active, every editable surface must
 * behave byte-identically to the base harness; with an overlay active, each
 * of the four surfaces (prompt blocks, procedure cards, TTSR rules, agent
 * specs) must reflect exactly the declared edit.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystem, buildSystemPrompt } from "../src/loop/prompt/prompt";
import { ruleHelp } from "../src/loop/feedback/rule-docs";
import { initTtsrManager } from "../src/loop/ttsr-init";
import { loadAgentSpecs } from "../src/config/agent-specs";
import { resetOverlayCache } from "../src/self-harness/overlay";
import { DEFAULT_CONVENTIONS } from "../src/infer-rules/conventions";
import type { IHarnessOverlay } from "../src/self-harness/self-harness.types";

let dir: string;
const SAVED_VARS = [
  "TSFORGE_SELF_HARNESS_OVERLAY",
  "TSFORGE_MODEL",
  "TSFORGE_HOME",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sh-inject-"));

  for (const name of SAVED_VARS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }

  // Hermetic: the registry-fallback path must look in the tmp dir, never the
  // developer's real ~/.tsforge (which may hold a promoted overlay).
  process.env.TSFORGE_HOME = dir;
  resetOverlayCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });

  for (const name of SAVED_VARS) {
    const value = savedEnv.get(name);

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  resetOverlayCache();
});

async function activateOverlay(overlay: Partial<IHarnessOverlay>): Promise<void> {
  const path = join(dir, "overlay.json");

  await writeFile(path, JSON.stringify(overlay));
  process.env.TSFORGE_SELF_HARNESS_OVERLAY = path;
  resetOverlayCache();
}

describe("no overlay → base harness byte-identical", () => {
  test("system prompt, rule help, agent specs, and TTSR are unchanged by the wiring", async () => {
    // Snapshot outputs with the overlay machinery in place but inactive.
    const system = buildSystem(DEFAULT_CONVENTIONS);
    const full = buildSystemPrompt(false, undefined);
    const help = ruleHelp([{ key: "TS2307", rule: "TS2307", message: "" }]);
    const specs = await loadAgentSpecs(dir);

    // The known base content is present and no overlay text can be (none exists).
    expect(system).toContain("Lead with action");
    expect(system).toContain("After every edit the harness AUTOMATICALLY");
    expect(system).toContain("Test hypotheses by RUNNING them");
    expect(full.startsWith(system)).toBe(true);
    expect(help).toContain("TS2307");

    const explore = specs.find((s) => s.id === "explore");

    expect(explore).toBeDefined();

    // Determinism: a second call produces the identical bytes.
    expect(buildSystem(DEFAULT_CONVENTIONS)).toBe(system);
    expect(buildSystemPrompt(false, undefined)).toBe(full);
    expect(ruleHelp([{ key: "TS2307", rule: "TS2307", message: "" }])).toBe(
      help
    );
  });
});

describe("prompt-block injection", () => {
  test("append stacks below the named block; replace substitutes it", async () => {
    const base = buildSystem(DEFAULT_CONVENTIONS);

    await activateOverlay({
      promptBlocks: {
        bootstrap: {
          mode: "append",
          text: "Create the required output artifact as early as possible.",
        },
        verification: {
          mode: "replace",
          text: "Always read the artifact back before concluding.",
        },
      },
    });

    const edited = buildSystem(DEFAULT_CONVENTIONS);

    expect(edited).not.toBe(base);
    // append: base line retained, new text directly after it
    expect(edited).toContain(
      "writing any code. (In TDD mode the test comes first; see the test-first guidance below.)\nCreate the required output artifact as early as possible."
    );
    // replace: base verification line gone, replacement present
    expect(edited).not.toContain("Test hypotheses by RUNNING them");
    expect(edited).toContain("read the artifact back before concluding");
    // non-edited blocks untouched
    expect(edited).toContain("After every edit the harness AUTOMATICALLY");
  });

  test("the extra block lands at the end of the full system prompt", async () => {
    await activateOverlay({
      promptBlocks: {
        extra: { mode: "append", text: "EXTRA-BLOCK-SENTINEL" },
      },
    });

    const full = buildSystemPrompt(false, undefined);

    expect(full.endsWith("EXTRA-BLOCK-SENTINEL")).toBe(true);
  });
});

describe("procedure-card injection", () => {
  test("card edit merges over the base doc; unknown rule without `what` stays absent", async () => {
    await activateOverlay({
      procedureCards: {
        TS2307: { procedure: "OVERLAY-PROCEDURE: verify the file exists." },
        "made-up-rule": { procedure: "no what, no base doc → not rendered" },
      },
    });

    const help = ruleHelp([
      { key: "TS2307", rule: "TS2307", message: "" },
      { key: "made-up-rule", rule: "made-up-rule", message: "" },
    ]);

    expect(help).toContain("OVERLAY-PROCEDURE: verify the file exists.");
    expect(help).not.toContain("made-up-rule");
  });

  test("a card with `what` can document a rule that has no base doc", async () => {
    await activateOverlay({
      procedureCards: {
        "brand-new-rule": {
          what: "OVERLAY-WHAT for a rule with no curated doc.",
        },
      },
    });

    const help = ruleHelp([
      { key: "brand-new-rule", rule: "brand-new-rule", message: "" },
    ]);

    expect(help).toContain("brand-new-rule: OVERLAY-WHAT");
  });
});

describe("TTSR injection", () => {
  test("overlay rules register; base rules keep priority on name collision", async () => {
    await activateOverlay({
      ttsrRules: [
        {
          name: "overlay-loop-breaker",
          condition: ["let me try a completely different"],
          scope: "content",
          guidance: "Stop exploring; produce the required artifact now.",
          repeatMode: "once",
        },
        {
          // Collides with a built-in default rule name — must NOT displace it.
          name: "no-as-any",
          condition: ["zzz"],
          scope: "content",
          guidance: "hijacked",
          repeatMode: "once",
        },
      ],
    });

    const events: string[] = [];
    const manager = await initTtsrManager(
      dir,
      (e) => {
        events.push(e.message);
      },
      "t1"
    );

    expect(manager).not.toBeNull();
    expect(
      events.some((m) => m.includes("1 self-harness overlay TTSR rule"))
    ).toBe(true);
  });
});

describe("agent-spec injection", () => {
  test("override merges onto an existing spec; unknown id creates nothing", async () => {
    await activateOverlay({
      agentSpecOverrides: [
        { id: "explore", maxTurns: 99, systemPrompt: "OVERLAY-PROMPT" },
        { id: "not-a-real-agent", systemPrompt: "must not appear" },
      ],
    });

    const specs = await loadAgentSpecs(dir);
    const explore = specs.find((s) => s.id === "explore");

    expect(explore?.maxTurns).toBe(99);
    expect(explore?.systemPrompt).toBe("OVERLAY-PROMPT");
    // untouched fields survive the merge
    expect(explore?.tools).toBeDefined();
    expect(specs.find((s) => s.id === "not-a-real-agent")).toBeUndefined();
  });
});
