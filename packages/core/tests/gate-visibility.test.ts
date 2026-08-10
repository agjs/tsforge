import { test, expect, describe } from "bun:test";
import {
  formatGateIdentity,
  formatPackActivationNotice,
  newlyActivatedPacks,
  packsGrew,
  sortedPacks,
  summarizeGateCommand,
} from "../src/loop/gate-visibility";
import { gateFeedback } from "../src/loop/feedback";
import { isHarnessUserInject } from "../src/loop/harness-inject";
import { doCheck } from "../src/loop/tools/check-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { ITask } from "../src/spec";

describe("gate-visibility helpers", () => {
  test("sortedPacks is stable and sorted", () => {
    expect(sortedPacks(["code-flow", "env-access"])).toEqual([
      "code-flow",
      "env-access",
    ]);
  });

  test("newlyActivatedPacks / packsGrew detect growth only", () => {
    expect(
      newlyActivatedPacks(["generic-ts"], ["generic-ts", "react"])
    ).toEqual(["react"]);
    expect(packsGrew(null, ["generic-ts"])).toBe(false);
    expect(packsGrew(["generic-ts"], ["generic-ts"])).toBe(false);
    expect(packsGrew(["generic-ts"], ["generic-ts", "react"])).toBe(true);
  });

  test("summarizeGateCommand keeps short accepts; collapses auto-gate shells", () => {
    expect(summarizeGateCommand("bun test")).toBe("bun test");
    expect(
      summarizeGateCommand(
        "TSFORGE_PACKS='code-flow,env-access' TSFORGE_RULE_OVERRIDES='{}' " +
          "/Users/ag/Documents/Code/tsforge/packages/core/node_modules/" +
          "@typescript/native/bin/tsc --noEmit -p .tsforge/tsconfig.gate.json " +
          "&& bunx eslint -c .tsforge/eslint.gate.mjs --cache ."
      )
    ).toBe("auto gate (tsc + eslint)");
  });

  test("formatGateIdentity includes short check label and packs", () => {
    const text = formatGateIdentity("bun test", ["env-access", "code-flow"]);

    expect(text).toBe("Check: bun test\nPacks: code-flow, env-access");
  });

  test("formatGateIdentity surfaces gate tsconfig floor for auto-gate shells", () => {
    const text = formatGateIdentity(
      "TSFORGE_PACKS='code-flow' tsc -p .tsforge/tsconfig.gate.json && eslint .",
      ["code-flow"]
    );

    expect(text).toContain("Check: auto gate");
    expect(text).toContain(
      "Typecheck: strict + noUncheckedIndexedAccess (gate tsconfig"
    );
  });

  test("formatGateIdentity never embeds TSFORGE_PACKS shell walls", () => {
    const text = formatGateIdentity(
      "TSFORGE_PACKS='code-flow' /opt/tsc --noEmit && bunx eslint .",
      ["code-flow"]
    );

    expect(text).toContain("Check: auto gate");
    expect(text).not.toContain("TSFORGE_PACKS");
    expect(text).not.toContain("/opt/tsc");
  });

  test("formatPackActivationNotice names full set and newly activated", () => {
    const notice = formatPackActivationNotice(
      ["generic-ts", "react-component-architecture", "env-access"],
      ["react-component-architecture"]
    );

    expect(notice.startsWith("Detected packs:")).toBe(true);
    expect(notice).toContain("newly activated: react-component-architecture");
    expect(notice).toContain("task-contract Check:");
  });
});

describe("gate RED identity surfaces", () => {
  test("doCheck JSON includes command and packs on failure", async () => {
    const ctx: IToolContext = {
      cwd: "/workspace",
      files: [],
      report: () => undefined,
      task: "t",
      runCheck: async () => ({
        passed: false,
        errors: [{ key: "a", message: "boom" }],
        output: "",
        autoFixed: [],
        command: "TSFORGE_PACKS='code-flow' eslint .",
        packs: ["code-flow", "env-access"],
      }),
    };

    const parsed = JSON.parse(await doCheck({}, ctx));

    expect(parsed.passed).toBe(false);
    // Model-visible command must be summarized — never the TSFORGE_PACKS shell.
    expect(parsed.command).toBe("auto gate (eslint)");
    expect(parsed.command).not.toContain("TSFORGE_PACKS");
    expect(parsed.packs).toEqual(["code-flow", "env-access"]);
  });

  test("doCheck JSON never embeds absolute harness toolchain paths", async () => {
    const harnessCmd =
      "TSFORGE_PACKS='code-flow' " +
      "/Users/ag/Documents/Code/tsforge/packages/core/node_modules/" +
      "@typescript/native/bin/tsc --noEmit -p .tsforge/tsconfig.gate.json " +
      "&& bunx eslint -c .tsforge/eslint.gate.mjs .";
    const ctx: IToolContext = {
      cwd: "/workspace",
      files: [],
      report: () => undefined,
      task: "t",
      runCheck: async () => ({
        passed: false,
        errors: [{ key: "a", message: "boom" }],
        output: "",
        autoFixed: [],
        command: harnessCmd,
        packs: ["code-flow"],
      }),
    };

    const raw = await doCheck({}, ctx);

    expect(raw).not.toContain("TSFORGE_PACKS=");
    expect(raw).not.toContain("packages/core/node_modules");
    expect(raw).not.toContain("/Users/ag/Documents/Code/tsforge");
    expect(JSON.parse(raw).command).toBe("auto gate (tsc + eslint)");
  });

  test("gateFeedback preamble includes live command and packs", async () => {
    const task: ITask = {
      id: "1",
      files: [],
      accept: "tsc --strict",
      intent: "",
    };

    const fb = await gateFeedback(
      [{ key: "x", message: "fail" }],
      task,
      "/tmp",
      [],
      null,
      ["code-flow", "env-access"]
    );

    expect(fb).toContain("The acceptance command still fails:");
    expect(fb).toContain("Check: tsc --strict");
    expect(fb).toContain("Packs: code-flow, env-access");
  });

  test("Detected packs: inject is classified as harness (AGENT paint)", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content: formatPackActivationNotice(["generic-ts", "react"], ["react"]),
      })
    ).toBe(true);
  });
});
