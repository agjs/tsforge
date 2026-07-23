import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boringstackCommandStage,
  reachabilityStage,
  judgeStage,
  signatureToError,
  locateParseError,
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

  test("the eslint-program-unparsable signature maps to a file-less rewrite-the-broken-file error", () => {
    const err = signatureToError("eslint-program-unparsable");

    // File-less (model-visible "own" error), phase 2, and steers toward a FULL
    // rewrite of the one broken file — not chasing the per-file cascade.
    expect(err.rule).toBe("eslint-program-unparsable");
    expect(err.file).toBeUndefined();
    expect(err.phase).toBe(2);
    expect(err.message).toContain("ONE broken file");
    expect(err.message).toContain("REWRITE IT IN FULL");
  });

  test("a discrete PARSE error is steered to a full rewrite (not a surgical patch)", () => {
    // The class the model can't fix by patching — observed live stuck at 2 `'>' expected`.
    const err = signatureToError(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Fx%2FX.tsx:5::Parsing%20error%3A%20'%3E'%20expected."
    );

    expect(err.file).toBe("apps/ui/src/features/x/X.tsx");
    expect(err.message).toContain("SYNTAX/PARSE error");
    expect(err.message).toContain("REWRITE THE WHOLE FILE");
    // A .tsx file already holds JSX — it must NOT get the "must be a `.tsx`" rename tip.
    expect(err.message).not.toContain("must be a `.tsx`");

    // A non-parse error is left untouched (no rewrite steer).
    const plain = signatureToError(
      "failure:apps%2Fui%2Fsrc%2Fx.ts:3:no-unused-vars:'y'%20is%20defined%20but%20never%20used."
    );

    expect(plain.message).not.toContain("REWRITE THE WHOLE FILE");
  });

  test("an UNQUOTED parse diagnostic still gets the rewrite steer", () => {
    // `Expression expected.` / `Declaration or statement expected.` carry no quoted token.
    const err = signatureToError(
      "failure:apps%2Fapi%2Fsrc%2Fx.ts:2::Expression%20expected."
    );

    expect(err.message).toContain("REWRITE THE WHOLE FILE");
  });

  test("a PathsWithMethod type error steers to BOTH causes, call-site FIRST (build12: wrong /api/… string, route WAS in spec)", () => {
    // build12: model used a wrong call-site string and re-ran generate:api 5× because the old
    // steer only ever said "route not in spec". The steer must name the call-site cause first.
    const msg =
      "Argument of type '\"/api/supplier\"' is not assignable to parameter of type 'PathsWithMethod<paths, \"post\">'.";
    const err = signatureToError(
      `failure:apps%2Fui%2Fsrc%2Ffeatures%2Fsupplier%2FSupplier.mutations.ts:12:no-unsafe:${encodeURIComponent(msg)}`
    );

    // Call-site cause named first, with the exact /api/v1/ format.
    expect(err.message).toContain("call site");
    expect(err.message).toContain("/api/v1/");
    // All three causes present: wrong path, wrong VERB (method-specific), unregistered route.
    expect(err.message).toContain("WRONG PATH");
    expect(err.message).toContain("WRONG VERB");
    expect(err.message).toContain("unregistered");
    // The steer must name the collection TRAILING SLASH (build14 endgame) — else the per-error
    // feedback contradicts the front-loaded guide when the model is stuck on a slashless POST.
    expect(err.message).toContain("TRAILING SLASH");
    // …and the wrong-lever warning: don't re-run generate:api for a call-site string bug.
    expect(err.message).toContain("Do NOT re-run generate:api");
    // A plain type error (no PathsWithMethod) is left untouched.
    const plain = signatureToError(
      "failure:apps%2Fui%2Fsrc%2Fx.ts:3:no-unsafe:Type%20'string'%20is%20not%20assignable%20to%20'number'."
    );

    expect(plain.message).not.toContain("call site");
  });

  test("a Readable<SuccessResponse> error steers to the CONSUMER unwrap, not a route/schema fix (build15 wall)", () => {
    const msg =
      "Type 'Readable<SuccessResponse<{ 200: {} }>>' is not assignable to type 'Promise<ISupplierItem>'.";
    const err = signatureToError(
      `failure:apps%2Fui%2Fsrc%2Ffeatures%2Fsupplier%2FSupplier.mutations.ts:20:no-unsafe:${encodeURIComponent(msg)}`
    );

    // Steer names it universal/expected and points at the consumer fix (infer, then unwrap).
    expect(err.message).toContain("UNIVERSAL");
    expect(err.message).toContain("CONSUMER");
    // Universal move is infer-don't-annotate; unwrap is shape-conditional (not blind .data).
    expect(err.message).toContain("let TS INFER");
    expect(err.message).toContain("don't blindly add");
    // Steer must name BOTH annotation sites — the fn AND the useMutation/useQuery HOOK generic
    // (build16 oscillated on the hook one; guide + steer must agree).
    expect(err.message).toContain("UseMutationResult<Readable");
    expect(err.message).toContain("HOOK generic");
    // Must NOT tell the model to fix the route/schema for this.
    expect(err.message).toContain("CANNOT remove it by editing the route");
  });

  test("a `'>' expected` in a .ts flags the JSX-must-be-.tsx cause; other .ts parse errors do NOT", () => {
    // The one class the .tsx tip is valid for.
    const jsx = signatureToError(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Fx%2FX.hooks.ts:9::'%3E'%20expected."
    );

    expect(jsx.message).toContain("must be a `.tsx`");

    // A plain `';' expected` in a .ts is NOT a JSX problem — must not suggest a rename detour.
    const semi = signatureToError(
      "failure:apps%2Fapi%2Fsrc%2Fx.ts:4::';'%20expected."
    );

    expect(semi.message).toContain("REWRITE THE WHOLE FILE");
    expect(semi.message).not.toContain("must be a `.tsx`");
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

  test("threads siblingEntities into the judge prompt (scopes to this feature's own job)", async () => {
    const seen: string[] = [];
    const capturing: IProvider = {
      complete: async (messages) => {
        for (const m of messages) {
          if (m.role === "user") {
            seen.push(m.content);
          }
        }

        return { content: '{"pass":true,"notes":"ok"}', toolCalls: [] };
      },
    };
    const stage = judgeStage(capturing, "/tmp/clone", feature, ["product"]);

    await stage.run("/tmp/clone");

    // The other slice's entity reaches the judge, so it won't reject this feature for
    // lacking a link to a not-yet-built child (the relational-collision park).
    expect(seen.join("\n")).toContain("product");
    expect(seen.join("\n")).toContain("separate slices");
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

describe("locateParseError", () => {
  test("names the ONE file with a real syntax error among good files (disambiguates the cascade)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-parse-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      await mkdir(join(dir, "apps/api/src"), { recursive: true });
      // Good files (must NOT be fingered)
      await writeFile(
        join(dir, "apps/api/src/ok.ts"),
        "export const n: number = 1;\n"
      );
      await writeFile(
        join(dir, "apps/ui/src/features/company/Good.tsx"),
        "export const G = () => <div className='x'>hi</div>;\n"
      );
      // The ONE broken file — malformed JSX ('>' expected)
      await writeFile(
        join(dir, "apps/ui/src/features/company/Broken.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const located = await locateParseError(dir);

      expect(located).not.toBeNull();
      expect(located?.file).toBe("apps/ui/src/features/company/Broken.tsx");
      expect(located?.detail.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when every source file parses cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-parse-ok-"));

    try {
      await mkdir(join(dir, "apps/ui/src"), { recursive: true });
      await writeFile(
        join(dir, "apps/ui/src/Ok.tsx"),
        "export const G = () => <span>ok</span>;\n"
      );

      expect(await locateParseError(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
