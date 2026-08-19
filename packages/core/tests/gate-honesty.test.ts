import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBoringstackGate } from "../src/loop/boringstack/gate-stages";
import type { Exec, IExecResult } from "../src/loop/boringstack/exec";
import type { SpecFetcher } from "../src/loop/boringstack/openapi-routes";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { IEntityAcceptance } from "../src/loop/boringstack/acceptance/acceptance.types";
import type { IProvider } from "../src/inference";

/**
 * GATE-HONESTY SUITE (observable-gates plan P3) — "disable-must-fail".
 *
 * Each test drives the REAL composed boringstack gate with an adversarial input that a
 * specific observable control must catch, and asserts that control's rule fires. The
 * point is not to re-test each control's logic (its own unit tests do that) but to prove
 * it is WIRED INTO THE PIPELINE and actually bites end-to-end: if a future change unwires
 * or weakens a control (drops the oracle call, makes a stage non-blocking, removes it from
 * composeBoringstackGate), its scenario here stops producing the expected rule and this
 * suite goes RED. It runs in the normal `bun test packages` CI — no live server, no DB, no
 * browser, deterministic.
 */

const feature: IFeature = {
  id: "note",
  desc: "a note",
  passes: false,
  attempts: 0,
};

const passingJudge: IProvider = {
  complete: async () => ({
    content: '{"pass":true,"notes":"ok"}',
    toolCalls: [],
  }),
};

const OK: IExecResult = { code: 0, stdout: "", stderr: "" };

/** A minimal statically-clean clone: the API route table mounts `noteRoutes`, so
 *  the reachability stage sees real inputs with zero static problems and its
 *  live-spec probe (the control under test) actually fires. */
async function cloneWithNoteRoutes(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-honesty-"));
  const routesDir = join(dir, "apps/api/src/config/routes");

  await mkdir(routesDir, { recursive: true });
  await writeFile(
    join(routesDir, "routes.ts"),
    `import { noteRoutes } from "../../api/note/note.routes";\n` +
      `export const routes = { note: noteRoutes };\n`
  );

  return dir;
}

/** A configurable exec: setup commands always succeed; db:push, the `bun -e` oracle probe,
 *  and the gate command are overridable per scenario. */
function mkExec(over: {
  push?: IExecResult;
  oracle?: IExecResult;
  gate?: IExecResult;
}): Exec {
  return async (argv) => {
    const cmd = argv.join(" ");

    if (argv[1] === "-e") {
      // The db:push recovery's DROP and the oracle probe are both `bun -e`; the oracle
      // script is the one querying information_schema.
      const script = argv[2] ?? "";

      return script.includes("information_schema")
        ? (over.oracle ?? { code: 0, stdout: "__ORACLE__[]", stderr: "" })
        : OK; // the drop
    }

    if (cmd.includes("db:push")) {
      return over.push ?? OK;
    }

    if (/lint:fix|(?:^|\s)format(?:\s|$)|eslintcache|^rm /u.test(cmd)) {
      return OK; // autofix setup
    }

    return over.gate ?? { code: 0, stdout: "all good", stderr: "" };
  };
}

const bookmark: IEntityAcceptance = {
  id: "Note",
  key: "note",
  nav: "Notes",
  fields: [
    { name: "title", type: "string", optional: false, valid: "t", invalid: [] },
    { name: "url", type: "string", optional: false, valid: "u", invalid: [] },
  ],
  shows: ["title", "url"],
  screens: ["list", "form"],
  parents: [],
  negatives: [],
  acceptanceCheck: "test note",
};

describe("gate-honesty (disable-must-fail): each observable control is wired and fires", () => {
  test("db:push recovery/surfacing — a headless rename crash (exit 0) reds the composed gate (rule db-push)", async () => {
    // If dbPushForce's detection or the command stage's exit-code short-circuit is
    // removed, this crash would pass as green and this test reds.
    const gate = composeBoringstackGate({
      cwd: "/nonexistent",
      exec: mkExec({
        push: {
          code: 0,
          stdout: "",
          stderr:
            "Error: Interactive prompts require a TTY terminal\n at promptColumnsConflicts",
        },
      }),
      evaluator: passingJudge,
      baseline: new Set<string>(),
      feature,
    });

    const r = await gate.run("/nonexistent");

    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.rule === "db-push")).toBe(true);
  });

  test("DB boundary oracle — db:push clean but a plan column absent reds the composed gate (rule db-schema-mismatch)", async () => {
    // If checkEntitySchema is unwired from boringstackCommandStage, this stops firing.
    const gate = composeBoringstackGate({
      cwd: "/nonexistent",
      exec: mkExec({
        oracle: {
          code: 0,
          // DB has title but NOT url (the plan demands both).
          stdout:
            '__ORACLE__["id","user_id","title","created_at","updated_at"]',
          stderr: "",
        },
      }),
      evaluator: passingJudge,
      baseline: new Set<string>(),
      feature,
      entity: bookmark,
    });

    const r = await gate.run("/nonexistent");

    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.rule === "db-schema-mismatch")).toBe(true);
  });

  test("runtime route-presence — routes absent from the served spec reds the composed gate (rule reachability)", async () => {
    // Command stage fully green (no entity → oracle skipped), but the running API's spec
    // does not serve the feature's routes. If the OpenAPI route probe is removed from
    // reachabilityStage, this stops firing.
    const servesOtherOnly: SpecFetcher = async () => ({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: { "/api/v1/other/": {}, "/api/v1/other/{id}": {} },
    });

    const dir = await cloneWithNoteRoutes();
    const gate = composeBoringstackGate({
      cwd: dir,
      exec: mkExec({ gate: { code: 0, stdout: "all good", stderr: "" } }),
      evaluator: passingJudge,
      baseline: new Set<string>(),
      feature,
      specFetcher: servesOtherOnly,
    });

    try {
      const r = await gate.run(dir);

      expect(r.passed).toBe(false);
      expect(r.errors.some((e) => e.rule === "reachability")).toBe(true);
      expect(r.errors[0]?.message).toContain("/api/v1/note/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SANITY: with every control's input HEALTHY, the composed gate is green (the suite can distinguish red from green)", async () => {
    // Proves the red scenarios above fail because of the injected defect, not because the
    // harness is red-by-default — otherwise "disable-must-fail" would be vacuous.
    const servesNote: SpecFetcher = async () => ({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: { "/api/v1/note/": {}, "/api/v1/note/{id}": {} },
    });

    const dir = await cloneWithNoteRoutes();
    const gate = composeBoringstackGate({
      cwd: dir,
      exec: mkExec({
        oracle: {
          code: 0,
          stdout:
            '__ORACLE__["id","user_id","title","url","created_at","updated_at"]',
          stderr: "",
        },
        gate: { code: 0, stdout: "all good", stderr: "" },
      }),
      evaluator: passingJudge,
      baseline: new Set<string>(),
      feature,
      entity: bookmark,
      specFetcher: servesNote,
    });

    try {
      const r = await gate.run(dir);

      expect(r.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
