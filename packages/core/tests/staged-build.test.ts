import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStaged,
  designBuild,
  implementBuild,
  generatePlan,
  formatTypeContract,
  hasImplementation,
  isImplementationFile,
  type IStagedBuildHost,
} from "../src/loop/staged-build";
import type { ISendResult } from "../src/loop/session";
import type { ILoopEvent } from "../src/loop";

/** The staged build extracted from Session (B2): these pin the phase
 *  orchestration against a fake host — gate save/restore, tool swapping,
 *  the interrupted short-circuit, and the green-skip of phase 2. */

interface IFakeHost extends IStagedBuildHost {
  readonly calls: string[];
  readonly sent: { message: string; opts: unknown }[];
  readonly events: ILoopEvent[];
}

function makeHost(opts: {
  cwd?: string;
  gatePasses?: boolean;
  sendResult?: ISendResult;
  planText?: string;
}): IFakeHost {
  const calls: string[] = [];
  const sent: { message: string; opts: unknown }[] = [];
  const events: ILoopEvent[] = [];
  let gate = "bun run build";

  return {
    calls,
    sent,
    events,
    // A real empty dir: implementBuild reads the contract globs from cwd, and
    // readFiles throws (rather than returning []) on a missing directory.
    cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "staged-empty-")),
    taskId: "t",
    get gate(): string {
      return gate;
    },
    setGate: (command: string): void => {
      calls.push(`setGate:${command}`);
      gate = command;
    },
    useDesignTools: (): void => {
      calls.push("useDesignTools");
    },
    useFullTools: (): void => {
      calls.push("useFullTools");
    },
    send: (message: string, sendOpts = {}): Promise<ISendResult> => {
      calls.push("send");
      sent.push({ message, opts: sendOpts });

      return Promise.resolve(opts.sendResult ?? { status: "done", turns: 3 });
    },
    fullGatePasses: (): Promise<boolean> => {
      calls.push("fullGatePasses");

      return Promise.resolve(opts.gatePasses ?? false);
    },
    completeOnce: (): Promise<string> => {
      calls.push("completeOnce");

      return Promise.resolve(opts.planText ?? "");
    },
    report: (event): void => {
      events.push(event);
    },
  };
}

describe("designBuild", () => {
  test("swaps to the design gate + design tools, then restores BOTH", async () => {
    const host = makeHost({});

    await designBuild(host, "build a crm", {}, "tsc --noEmit");

    // Order matters: design gate on → design tools → send → full tools → gate back.
    expect(host.calls).toEqual([
      "setGate:tsc --noEmit",
      "useDesignTools",
      "send",
      "useFullTools",
      "setGate:bun run build",
    ]);
    expect(host.gate).toBe("bun run build"); // the original gate survived
    expect(host.sent[0]?.message).toContain("build a crm");
    expect(host.sent[0]?.message).toContain("STEP 1 of 2");
    // The design prompt matches the web guidance: bare PascalCase, no I-prefix.
    expect(host.sent[0]?.message).toContain("no `I` prefix");
  });
});

describe("buildStaged", () => {
  test("an interrupted design phase short-circuits (no implement)", async () => {
    const host = makeHost({
      sendResult: { status: "interrupted", turns: 1 },
    });

    const result = await buildStaged(host, "build it");

    expect(result.status).toBe("interrupted");
    // fullGatePasses belongs to implementBuild — it must never have run.
    expect(host.calls).not.toContain("fullGatePasses");
  });

  test("a completed design phase flows into implement", async () => {
    const host = makeHost({ gatePasses: false });

    await buildStaged(host, "build it");

    // Types-only phase 1 (empty cwd) → implement runs. The gate probe is now
    // skipped in this case (no implementation to protect from a rebuild), so the
    // proof that phase 2 ran is the second send carrying STEP 2 — not a gate call.
    expect(host.calls).not.toContain("fullGatePasses");
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]?.message).toContain("STEP 2 of 2");
  });
});

describe("isImplementationFile / hasImplementation", () => {
  test("type/constant/generated/test files and scaffold are NOT implementation", () => {
    for (const p of [
      "src/game/game.types.ts",
      "src/game/game.constants.ts",
      "src/vite-env.d.ts",
      "src/routeTree.gen.ts",
      "src/lib/format.test.ts",
      "src/components/ui/button.tsx",
      "src/main.ts",
      "src/main.tsx",
      // laid down by scaffoldWeb in EVERY build — counting them made the
      // phase-2 skip check always-true (hollow-app bug)
      "src/routes/__root.tsx",
      "src/routes/index.tsx",
    ]) {
      expect(isImplementationFile(p)).toBe(false);
    }
  });

  test("views/components/store/hooks ARE implementation", () => {
    for (const p of [
      "src/views/Home/index.tsx",
      "src/store/store.ts",
      "src/views/Home/home.hooks.ts",
      "src/game/game.ts",
      // real route files beyond the scaffold pair still count
      "src/routes/projects.tsx",
      "src/routes/projects.$projectId.tsx",
    ]) {
      expect(isImplementationFile(p)).toBe(true);
    }
  });

  test("the hollow platformer file set has NO implementation; a real app does", () => {
    expect(
      hasImplementation([
        "src/main.ts",
        "src/vite-env.d.ts",
        "src/game/game.types.ts",
        "src/game/game.constants.ts",
        "src/physics/physics.types.ts",
      ])
    ).toBe(false);
    expect(
      hasImplementation(["src/main.tsx", "src/views/Home/index.tsx"])
    ).toBe(true);
  });
});

describe("implementBuild", () => {
  test("skips phase 2 when phase 1 BUILT a real app and it is green (no rebuild)", async () => {
    // Phase 1 over-delivered: a real implementation file exists (not just types).
    const dir = mkdtempSync(join(tmpdir(), "staged-built-"));

    mkdirSync(join(dir, "src", "views", "Home"), { recursive: true });
    writeFileSync(
      join(dir, "src", "views", "Home", "index.tsx"),
      "export function Home() { return null; }\n"
    );

    const host = makeHost({ cwd: dir, gatePasses: true });

    const result = await implementBuild(host);

    expect(result).toEqual({ status: "done", turns: 0 });
    expect(host.calls).not.toContain("send");
    expect(
      host.events.some((e) => e.message.includes("skipping phase 2"))
    ).toBe(true);
  });

  test("does NOT skip when phase 1 wrote ONLY types/constants, even if green (the hollow-app bug)", async () => {
    // The regression: a types-only phase 1 leaves the empty scaffold, which
    // passes the gate — but the app was never built. Phase 2 MUST run.
    const dir = mkdtempSync(join(tmpdir(), "staged-typesonly-"));

    mkdirSync(join(dir, "src", "game"), { recursive: true });
    writeFileSync(
      join(dir, "src", "game", "game.types.ts"),
      "export interface GameState { score: number }\n"
    );
    writeFileSync(
      join(dir, "src", "game", "game.constants.ts"),
      "export const GRAVITY = 0.6;\n"
    );
    // The untouched scaffold entry point — must NOT count as implementation.
    writeFileSync(join(dir, "src", "main.ts"), 'document.title = "app";\n');

    const host = makeHost({ cwd: dir, gatePasses: true });

    const result = await implementBuild(host);

    // Phase 2 ran (send called), NOT skipped.
    expect(host.calls).toContain("send");
    expect(
      host.events.some((e) => e.message.includes("skipping phase 2"))
    ).toBe(false);
    expect(result.turns).not.toBe(0);
  });

  test("injects human plan notes under the approved-plan heading", async () => {
    const host = makeHost({ gatePasses: false });

    await implementBuild(host, "rename Deal to Opportunity");

    expect(host.sent[0]?.message).toContain(
      "## Approved plan — follow these decisions"
    );
    expect(host.sent[0]?.message).toContain("rename Deal to Opportunity");
  });

  test("re-injects the REAL type contract from disk before implementing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-build-"));

    mkdirSync(join(dir, "src", "deal"), { recursive: true });
    writeFileSync(
      join(dir, "src", "deal", "deal.types.ts"),
      "export interface Deal { id: string }\n"
    );

    const host = makeHost({ cwd: dir, gatePasses: false });

    await implementBuild(host);

    const prompt = host.sent[0]?.message ?? "";

    expect(prompt).toContain("THE TYPE CONTRACT you just designed");
    expect(prompt).toContain("deal.types.ts");
    expect(prompt).toContain("interface Deal");
  });
});

describe("generatePlan", () => {
  test("returns the trimmed completion", async () => {
    const host = makeHost({ planText: "  ## Plan\n1. things\n  " });

    expect(await generatePlan(host)).toBe("## Plan\n1. things");
    expect(host.calls).toEqual(["completeOnce"]);
  });
});

describe("formatTypeContract", () => {
  test("empty file list ⇒ empty string (nothing to anchor)", () => {
    expect(formatTypeContract([])).toBe("");
  });

  test("formats each file as a commented block inside one ts fence", () => {
    const out = formatTypeContract([
      { path: "src/a/a.types.ts", content: "export interface A {}\n" },
      { path: "src/b/b.constants.ts", content: "export const B = 1;\n" },
    ]);

    expect(out).toContain("// src/a/a.types.ts");
    expect(out).toContain("// src/b/b.constants.ts");
    expect(out).toContain("```ts");
    expect(out.trimEnd().endsWith("```")).toBe(true);
  });
});
