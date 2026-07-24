import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boringstackCommandStage,
  composeBoringstackGate,
  reachabilityStage,
  judgeStage,
  signatureToError,
  locateParseError,
} from "../src/loop/boringstack/gate-stages";
import { scopeFor, featureOwnedGlobs } from "../src/loop/boringstack/build";
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

  // A realistic cascade: the composed gate echoes `::tsforge-app <app>::` before each app's
  // stages, and the parserOptions.project error lands inside that app's section.
  const cascadeFor = (dir: string, app = "apps/ui"): string =>
    [
      `::tsforge-app ${app}::`,
      join(dir, `${app}/src/features/company/Company.tsx`),
      "  1:29 error Parsing error: parserOptions.project has been set for @typescript-eslint/parser",
      "",
      "✖ 1 problem (1 error, 0 warnings)",
    ].join("\n");

  const COMPANY_SCOPE = [
    "apps/ui/src/features/company/**",
    "apps/api/src/api/company/**",
  ];

  test("unparsable cascade → enriches with the located broken file, IGNORING valid-TS siblings (integration path)", async () => {
    // The panel's core findings: (1) the enrichment branch must be exercised end-to-end against a
    // REAL filesystem — not just locateParseError in isolation; (2) the parser replacement must be
    // proven on the exact valid-TypeScript constructs that a wrong parser (Bun.Transpiler /
    // transpileModule) mis-flags. Here healthy siblings use `const enum`, `import type`, and a
    // `<T,>` generic — all valid TS that typescript-eslint parses — and MUST NOT be named.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      // Valid-TS constructs a non-parser tool would wrongly reject — must NOT be fingered.
      await writeFile(
        join(dir, "apps/ui/src/features/company/Enum.ts"),
        "export const enum Status { Open, Closed }\n"
      );
      await writeFile(
        join(dir, "apps/ui/src/features/company/Types.ts"),
        "import type { ReactNode } from 'react';\nexport const render = (n: ReactNode): ReactNode => n;\n"
      );
      await writeFile(
        join(dir, "apps/ui/src/features/company/Generic.ts"),
        "export function identity<T,>(x: T): T {\n  return x;\n}\n"
      );
      // The ONE genuinely malformed file the cascade hides ('>' expected).
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir)),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable).toBeDefined();
      // The enrichment appended a hint that NAMES the real broken file the cascade hid,
      expect(unparsable?.message).toContain("A real syntax error is in");
      expect(unparsable?.message).toContain(
        "apps/ui/src/features/company/Company.tsx"
      );
      // with the located line/col detail and the fix framing,
      expect(unparsable?.message).toContain("line 1:");
      // and it did NOT falsely finger ANY valid-TS sibling (the whole point of the parser fix).
      expect(unparsable?.message).not.toContain("Enum.ts");
      expect(unparsable?.message).not.toContain("Types.ts");
      expect(unparsable?.message).not.toContain("Generic.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("located file OUTSIDE the feature scope → NO pointer appended (base guidance untouched, no scope bypass)", async () => {
    // Scope-bypass finding: the guidance must never name/direct a file the model does not own. A
    // broken file in ANOTHER feature's dir (same failing app) yields NO appended pointer — the
    // generic base message (which names no specific file) stands.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-oos-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/contact"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "apps/ui/src/features/contact/Contact.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir)),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable).toBeDefined();
      // No append: the out-of-scope file is never named nor directed for a rewrite.
      expect(unparsable?.message).not.toContain("A real syntax error is in");
      expect(unparsable?.message).not.toContain("Contact.tsx");
      // The generic base guidance is left untouched (names no specific file → no bypass).
      expect(unparsable?.message).toContain("could not build its program");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("correlation: a UI cascade is NOT mis-attributed to an unrelated broken API file", async () => {
    // The panel's deep finding: the locator must scan the app whose section actually shows the
    // cascade. Here the cascade is in apps/ui, an in-scope UI file is broken, AND an unrelated
    // out-of-scope API file is ALSO broken. The API file must be ignored (different app), so the
    // in-scope UI file is named and the feature is NOT wrongly marked blocked.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-corr-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      await mkdir(join(dir, "apps/api/src/api/other"), { recursive: true });
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );
      // Unrelated broken API file — must be ignored because the cascade is in apps/ui.
      await writeFile(
        join(dir, "apps/api/src/api/other/other.service.ts"),
        "export const bad: = 1;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir, "apps/ui")),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable?.message).toContain(
        "apps/ui/src/features/company/Company.tsx"
      );
      expect(unparsable?.message).toContain("A real syntax error is in");
      // The unrelated API file was NOT scanned, so it is neither named nor treated as the blocker.
      expect(unparsable?.message).not.toContain("other.service.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unparsable cascade with NO locatable broken file → NO append (base guidance untouched)", async () => {
    // Honesty: if locateParseError finds nothing (a config/`include` failure, or the broken file was
    // already fixed on disk), the enrichment must NOT fabricate a file pointer — the base stands.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-clean-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const G = () => <div className='x'>hi</div>;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir)),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable).toBeDefined();
      expect(unparsable?.message).not.toContain("A real syntax error is in");
      expect(unparsable?.message).toContain("could not build its program");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty scopeGlobs (default) → NO append (can't confirm ownership, so never names a file)", async () => {
    // An unknown/empty scope must not fail OPEN. With no ownership info we append nothing (a safe
    // no-op), so no file is ever named or directed.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-noscope-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      // No scopeGlobs passed → default [].
      const stage = boringstackCommandStage(dir, execWith(1, cascadeFor(dir)));
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable?.message).not.toContain("A real syntax error is in");
      expect(unparsable?.message).toContain("could not build its program");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("TWO broken feature-owned files → names one, WITHOUT a false 'only file / cascade clears' claim", async () => {
    // Round-6 finding: with 2+ broken files, claiming the named one is THE file that clears the
    // cascade mis-steers. The message must name one owned file and admit there may be more.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-multi-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const A = () => <div<;\n"
      );
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.form.tsx"),
        "export const B = () => <span<;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir)),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      // The APPENDED pointer names an owned broken file AND admits there may be more than one —
      // so it never claims (as the earlier rounds did) that this single file clears the cascade.
      expect(unparsable?.message).toContain("A real syntax error is in");
      expect(unparsable?.message).toContain("there may be more than one");
      // The COMBINED message (base + append) carries NO false single-file certainty — the base was
      // rewritten so this contradiction can't hide there (the round-7 finding).
      expect(unparsable?.message).not.toContain("ONE broken file");
      expect(unparsable?.message).not.toContain("clears at once");
      // Names one of the two broken company files (whichever the scan hits first).
      const names =
        unparsable?.message.includes("Company.tsx") === true ||
        unparsable?.message.includes("Company.form.tsx") === true;

      expect(names).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an out-of-scope broken file does NOT suppress a later in-scope broken file (scope filter applied DURING scan)", async () => {
    // Round-6 finding: scope must be checked during the scan, not on a single first hit — else a
    // broken out-of-scope file encountered first makes enrichment a no-op despite a broken owned file.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-cmd-parse-order-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/contact"), {
        recursive: true,
      });
      await mkdir(join(dir, "apps/ui/src/features/company"), {
        recursive: true,
      });
      // Out of company scope (encountered in whatever Bun.Glob order):
      await writeFile(
        join(dir, "apps/ui/src/features/contact/Contact.tsx"),
        "export const A = () => <div<;\n"
      );
      // In company scope — MUST be the one named regardless of walk order:
      await writeFile(
        join(dir, "apps/ui/src/features/company/Company.tsx"),
        "export const B = () => <span<;\n"
      );

      const stage = boringstackCommandStage(
        dir,
        execWith(1, cascadeFor(dir)),
        COMPANY_SCOPE
      );
      const result = await stage.run(dir);

      const unparsable = result.errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      expect(unparsable?.message).toContain(
        "apps/ui/src/features/company/Company.tsx"
      );
      expect(unparsable?.message).not.toContain("Contact.tsx");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  test("the eslint-program-unparsable signature maps to a file-less, honest (no false single-file certainty) error", () => {
    const err = signatureToError("eslint-program-unparsable");

    // File-less (model-visible "own" error), phase 2. The base message steers toward finding the
    // genuine syntax error(s) in OWNED files — WITHOUT the old false certainty ("ONE broken file",
    // "the whole cascade clears at once") that contradicted the multi-file enrichment, and WITHOUT
    // a blanket "REWRITE IT IN FULL" that could direct a wholesale rewrite of a shared file.
    expect(err.rule).toBe("eslint-program-unparsable");
    expect(err.file).toBeUndefined();
    expect(err.phase).toBe(2);
    expect(err.message).toContain("could not build its program");
    expect(err.message).toContain("files YOU OWN");
    expect(err.message).toContain("Do NOT wholesale-rewrite shared files");
    // No false single-file certainty, no blanket full-rewrite directive.
    expect(err.message).not.toContain("ONE broken file");
    expect(err.message).not.toContain("REWRITE IT IN FULL");
    expect(err.message).not.toContain("clears at once");
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

      const located = await locateParseError(
        dir,
        ["apps/api", "apps/ui"],
        () => true
      );

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

      expect(
        await locateParseError(dir, ["apps/api", "apps/ui"], () => true)
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does NOT false-positive on valid TypeScript a non-parser tool mis-flags (const enum / import type / generic)", async () => {
    // The exact regression the panel demanded: `ts.transpileModule` (and Bun.Transpiler) report
    // some of these valid constructs as errors; the parser (getSyntacticDiagnostics) must not.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-parse-validts-"));

    try {
      await mkdir(join(dir, "apps/api/src"), { recursive: true });
      await mkdir(join(dir, "apps/ui/src"), { recursive: true });
      await writeFile(
        join(dir, "apps/api/src/Enum.ts"),
        "export const enum Level { Low, High }\n"
      );
      await writeFile(
        join(dir, "apps/api/src/Reexport.ts"),
        "export { type Foo } from './foo';\n"
      );
      await writeFile(
        join(dir, "apps/ui/src/Generic.ts"),
        "export function first<T,>(xs: readonly T[]): T | undefined {\n  return xs[0];\n}\n"
      );

      expect(
        await locateParseError(dir, ["apps/api", "apps/ui"], () => true)
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("locates a syntax error in an API TEST file (apps/api/tests is editable scope, so it must be scannable)", async () => {
    // The editable scope includes `apps/api/tests/api/<feature>/**`; a parse error there breaks the
    // type-aware program the same way, so it must be locatable — not silently missed.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-parse-apitests-"));

    try {
      await mkdir(join(dir, "apps/api/tests/api/company"), { recursive: true });
      await writeFile(
        join(dir, "apps/api/tests/api/company/company.route.test.ts"),
        "export const bad: = 1;\n"
      );

      const located = await locateParseError(
        dir,
        ["apps/api", "apps/ui"],
        () => true
      );

      expect(located?.file).toBe(
        "apps/api/tests/api/company/company.route.test.ts"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("composeBoringstackGate scope wiring", () => {
  const passthroughJudge: IProvider = {
    complete: async () => ({
      content: '{"pass":true,"notes":"ok"}',
      toolCalls: [],
    }),
  };
  // composeBoringstackGate derives the rewritable globs from feature.id ("note") via
  // featureOwnedGlobs — there is NO scopeGlobs param to forget, so the wiring is exercised here.
  const noteCascade = (dir: string): string =>
    [
      "::tsforge-app apps/ui::",
      join(dir, "apps/ui/src/features/note/Note.tsx"),
      "  1:29 error Parsing error: parserOptions.project has been set for @typescript-eslint/parser",
      "",
      "✖ 1 problem (1 error, 0 warnings)",
    ].join("\n");

  const runComposed = async (dir: string, output: string): Promise<string> => {
    const gate = composeBoringstackGate({
      cwd: dir,
      exec: execWith(1, output),
      evaluator: passthroughJudge,
      baseline: new Set<string>(),
      feature,
    });
    const result = await gate.run(dir);

    return (
      result.errors.find((e) => e.rule === "eslint-program-unparsable")
        ?.message ?? ""
    );
  };

  test("wiring: composeBoringstackGate derives the feature's OWN dirs → names an in-scope broken file", async () => {
    // The recurring wiring finding: the rewritable scope must reach the command stage. composeBoringstackGate
    // derives featureOwnedGlobs(feature.id) internally (feature = "note"), so this exercises the real path
    // with NO scopeGlobs to pass — a broken file in the note feature dir is named.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-compose-in-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/note"), { recursive: true });
      await writeFile(
        join(dir, "apps/ui/src/features/note/Note.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const message = await runComposed(dir, noteCascade(dir));

      expect(message).toContain("apps/ui/src/features/note/Note.tsx");
      expect(message).toContain("A real syntax error is in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wiring: a broken file OUTSIDE the feature's own dirs gets NO append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-compose-out-"));

    try {
      // A broken file in ANOTHER feature's dir — not covered by featureOwnedGlobs("note").
      await mkdir(join(dir, "apps/ui/src/features/other"), { recursive: true });
      await writeFile(
        join(dir, "apps/ui/src/features/other/Other.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const message = await runComposed(dir, noteCascade(dir));

      expect(message).not.toContain("A real syntax error is in");
      expect(message).not.toContain("Other.tsx");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wiring: a SHARED add-only file (app.schema.ts) is NEVER named for rewrite even when broken", async () => {
    // scope-bypass finding: scopeFor grants edit access to shared add-only files, but the locator
    // must use featureOwnedGlobs (feature dirs only), so a broken shared file is not named.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-compose-shared-"));

    try {
      await mkdir(join(dir, "apps/api/src/clients/postgres/schema"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "apps/api/src/clients/postgres/schema/app.schema.ts"),
        "export const bad: = 1;\n"
      );

      // Cascade attributed to apps/api; only the shared schema file is broken.
      const output = [
        "::tsforge-app apps/api::",
        join(dir, "apps/api/src/clients/postgres/schema/app.schema.ts"),
        "  1:14 error Parsing error: parserOptions.project has been set for @typescript-eslint/parser",
        "✖ 1 problem (1 error, 0 warnings)",
      ].join("\n");

      const message = await runComposed(dir, output);

      expect(message).not.toContain("A real syntax error is in");
      expect(message).not.toContain("app.schema.ts");
      expect(message).toContain("could not build its program");
      // The base must NOT direct a blanket full rewrite (which could clobber the shared file); it
      // explicitly warns against wholesale-rewriting shared files.
      expect(message).not.toContain("REWRITE IT IN FULL");
      expect(message).toContain("Do NOT wholesale-rewrite shared files");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cascade with NO ::tsforge-app section → NO append (unattributed, we don't guess)", async () => {
    // No both-apps fallback: an unattributed cascade is a silent no-op even with a broken file on disk.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-compose-nosection-"));

    try {
      await mkdir(join(dir, "apps/ui/src/features/note"), { recursive: true });
      await writeFile(
        join(dir, "apps/ui/src/features/note/Note.tsx"),
        "export const B = () => <div className='x' hi</div>;\n"
      );

      const output = [
        join(dir, "apps/ui/src/features/note/Note.tsx"),
        "  1:29 error Parsing error: parserOptions.project has been set for @typescript-eslint/parser",
        "✖ 1 problem (1 error, 0 warnings)",
      ].join("\n");

      const message = await runComposed(dir, output);

      expect(message).not.toContain("A real syntax error is in");
      expect(message).toContain("could not build its program");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scopeFor", () => {
  test("covers the feature's UI/API source AND its API test dir (so a parse error in either is in-scope)", () => {
    const globs = scopeFor("company");
    const inScope = (file: string): boolean =>
      globs.some((g) => new Bun.Glob(g).match(file));

    expect(inScope("apps/ui/src/features/company/Company.tsx")).toBe(true);
    expect(inScope("apps/api/src/api/company/company.service.ts")).toBe(true);
    expect(inScope("apps/api/tests/api/company/company.route.test.ts")).toBe(
      true
    );
    // Another feature's file is NOT in scope.
    expect(inScope("apps/ui/src/features/contact/Contact.tsx")).toBe(false);
  });
});

describe("featureOwnedGlobs", () => {
  test("covers the feature's own dirs but EXCLUDES the shared add-only files (no wholesale-rewrite target)", () => {
    const globs = featureOwnedGlobs("company");
    const owned = (file: string): boolean =>
      globs.some((g) => new Bun.Glob(g).match(file));

    // Feature-exclusive dirs — safe to name for a full rewrite.
    expect(owned("apps/ui/src/features/company/Company.tsx")).toBe(true);
    expect(owned("apps/api/src/api/company/company.service.ts")).toBe(true);
    expect(owned("apps/api/tests/api/company/company.route.test.ts")).toBe(
      true
    );
    // Shared ADD-ONLY files scopeFor grants edit access to must NOT be owned (never rewrite them).
    expect(owned("apps/api/src/clients/postgres/schema/app.schema.ts")).toBe(
      false
    );
    expect(owned("apps/ui/src/lib/i18n/locales/en.json")).toBe(false);
    expect(owned("apps/ui/src/components/core/AppSidebar/AppSidebar.tsx")).toBe(
      false
    );
    expect(owned("apps/ui/src/app/router/routes.tsx")).toBe(false);
  });
});
