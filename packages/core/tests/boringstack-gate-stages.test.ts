import { test, expect, describe } from "bun:test";
import {
  boringstackCommandStage,
  reachabilityStage,
  judgeStage,
  signatureToError,
} from "../src/loop/boringstack/gate-stages";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { IProvider } from "../src/inference";

const feature: IFeature = {
  id: "note",
  desc: "a note",
  passes: false,
  attempts: 0,
};

const execWith =
  (code: number, stdout: string): Exec =>
  async () => ({ code, stdout, stderr: "" });

describe("boringstackCommandStage", () => {
  test("green gate → passed, no errors", async () => {
    const stage = boringstackCommandStage(
      "/tmp/clone",
      execWith(0, "all good")
    );
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("red gate → each failure signature becomes an IErrorItem (key = signature)", async () => {
    const out = "1:1 error Unexpected  no-console\nerror TS2322: bad";
    const stage = boringstackCommandStage("/tmp/clone", execWith(1, out));
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);

    // Every error carries a stable key so checkStuck can fingerprint it and the
    // differential wrapper can suppress baseline signatures.
    for (const e of r.errors) {
      expect(typeof e.key).toBe("string");
      expect(e.key.length).toBeGreaterThan(0);
    }
  });

  test("lint-meta failure is actionable and attributed to the downstream UI phase", async () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
[lint:meta] No violations.
::tsforge-app apps/ui::
[lint:meta] 1 violation(s):

  ${cwd}/apps/ui/src/features/note/Note.store.ts
    logic-files-require-test-sibling: Missing colocated test. Expected \`src/features/note/Note.store.test.ts\`.`;
    const stage = boringstackCommandStage(cwd, execWith(1, out));
    const result = await stage.run(cwd);
    const error = result.errors[0];

    expect(error?.file).toBe("apps/ui/src/features/note/Note.store.ts");
    expect(error?.rule).toBe("logic-files-require-test-sibling");
    expect(error?.message).toContain("Note.store.test.ts");
    expect(error?.phase).toBe(2);
  });

  test("unknown failure format preserves the final failing app, not the healthy output head", async () => {
    const out = `::tsforge-app apps/api::
healthy API output that used to consume the first 500 characters
::tsforge-app apps/ui::
UNFAMILIAR TOOL FAILURE: the useful downstream detail`;
    const stage = boringstackCommandStage("/tmp/clone", execWith(1, out));
    const result = await stage.run("/tmp/clone");
    const error = result.errors[0];

    expect(error?.key).toBe("gate-nonzero:apps/ui");
    expect(error?.phase).toBe(2);
    expect(error?.message).toContain("useful downstream detail");
    expect(error?.message).not.toContain("healthy API output");
  });
});

describe("signatureToError", () => {
  test("an openapi-unreachable signature maps to a file-less, model-visible infra error", () => {
    const sig = "openapi-unreachable:connection-refused";
    const err = signatureToError(sig);

    // NO file — so it stays an "own" error the model sees, not a locked/out-of-scope
    // diagnostic. Phase 2 matches the apps/ui stage it replaces. The key stays the
    // stable class; the actionable guidance (incl. the class + dev.sh) is built here.
    expect(err.key).toBe(sig);
    expect(err.rule).toBe("openapi-unreachable");
    expect(err.file).toBeUndefined();
    expect(err.phase).toBe(2);
    expect(err.message).toContain("connection-refused");
    expect(err.message).toContain("dev.sh up");
    expect(err.message).toContain("Do NOT edit");
  });

  test("a syntax Parsing-error signature keeps its file/phase and gets a REWRITE-in-full steer", () => {
    const file = "apps/ui/src/features/x/X.tsx";
    const sig = `failure:${encodeURIComponent(file)}:4:${encodeURIComponent(
      "syntax"
    )}:${encodeURIComponent("Parsing error: '}' expected")}`;
    const err = signatureToError(sig);

    // Correct routing (not a file-less token): the broken file + its UI phase...
    expect(err.file).toBe(file);
    expect(err.phase).toBe(2);
    expect(err.rule).toBe("syntax");
    // ...plus the steer that replaces the removed global token's guidance.
    expect(err.message).toContain("Parsing error: '}' expected");
    expect(err.message).toContain("REWRITE this file in full");
  });

  test("a KEPT parserOptions.project error gets the DOWNSTREAM-noise steer, never the rewrite-this-file steer", () => {
    const file = "apps/api/src/api/x/x.ts";
    const msg =
      "Parsing error: ESLint was configured to run on x.ts using parserOptions.project: tsconfig.json";
    const sig = `failure:${encodeURIComponent(file)}:1:${encodeURIComponent(
      "syntax"
    )}:${encodeURIComponent(msg)}`;
    const err = signatureToError(sig);

    // Same syntax/`Parsing error:` shape, but it's a cascade victim, not a break: the
    // signature is KEPT (located, counted) and carries the decision-procedure steer —
    // it points at the real break elsewhere, and explicitly tells the model NOT to
    // rewrite THIS file (that's only for the one real break).
    expect(err.message).toContain(msg);
    expect(err.message).toContain("DOWNSTREAM");
    expect(err.message).toContain("Do NOT edit this file");
    expect(err.message).not.toContain("REWRITE this file in full");
  });
});

describe("reachabilityStage", () => {
  test("when feature directory doesn't exist → skips gracefully (no reachability errors)", async () => {
    const stage = reachabilityStage("/nonexistent", "note");
    const r = await stage.run("/nonexistent");

    // Without the router/API files present, the check can't prove it's unreachable, so it passes
    expect(r.passed).toBe(true);
  });
});

describe("judgeStage", () => {
  test("judge rejects → one IErrorItem with rule 'judge' and a resolvable file", async () => {
    const providerWithReject: IProvider = {
      complete: async () => ({
        content: '{"pass":false,"notes":"stub only"}',
        toolCalls: [],
      }),
    };
    const stage = judgeStage(providerWithReject, "/tmp/clone", feature);
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.rule).toBe("judge");
    expect(r.errors[0]?.message).toContain("stub only");
  });

  test("judge passes → green", async () => {
    const providerWithPass: IProvider = {
      complete: async () => ({
        content: '{"pass":true,"notes":"good"}',
        toolCalls: [],
      }),
    };
    const stage = judgeStage(providerWithPass, "/tmp/clone", feature);

    expect((await stage.run("/tmp/clone")).passed).toBe(true);
  });
});
