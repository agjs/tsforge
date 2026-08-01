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
  testIdStage,
} from "../src/loop/boringstack/gate-stages";
import { scopeFor, featureOwnedGlobs } from "../src/loop/boringstack/build";
import { testIdsFor } from "../src/loop/boringstack/acceptance/acceptance-spec";
import type { IEntityAcceptance } from "../src/loop/boringstack/acceptance/acceptance.types";
import type { Exec } from "../src/loop/boringstack/exec";
import type { SpecFetcher } from "../src/loop/boringstack/openapi-routes";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { IProvider } from "../src/inference";

const feature: IFeature = {
  id: "note",
  desc: "a note",
  passes: false,
  attempts: 0,
};

// The command stage runs setup steps (eslint-cache clear, lint:fix, format, db:push, and the
// db-push recovery's `bun -e` drop) BEFORE the gate. Those succeed independently; only the GATE
// returns the test's code/stdout. Modelling that here keeps a RED-gate test (code 1) exercising
// the gate path, not the db:push short-circuit.
const execWith =
  (code: number, stdout: string): Exec =>
  async (argv) => {
    const cmd = argv.join(" ");
    const isDrop = argv[1] === "-e";

    if (
      isDrop ||
      /lint:fix|(?:^|\s)format(?:\s|$)|db:push|eslintcache/u.test(cmd)
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }

    return { code, stdout, stderr: "" };
  };

// An exec whose db:push FAILS with the given output (everything else succeeds / gate is green),
// to drive the command stage's db:push-failure path. Records every command it's asked to run
// (into `calls`, when provided) so a test can PROVE the gate was never invoked afterward.
const execDbPushFails =
  (pushOutput: string, calls: string[] = []): Exec =>
  async (argv) => {
    const cmd = argv.join(" ");

    calls.push(cmd);

    if (cmd.includes("db:push")) {
      return { code: 1, stdout: pushOutput, stderr: "" };
    }

    return { code: 0, stdout: "all good", stderr: "" };
  };

// Every real `bun run db:push` failure begins with this drizzle-kit preamble (it mentions
// `drizzle.config.ts` and "database"). The db:push tests prepend it so they run against
// production-shaped output rather than bare one-line errors.
const DRIZZLE_PREAMBLE =
  "No config path provided, using default 'drizzle.config.ts'\n" +
  "Reading config file '/app/apps/api/drizzle.config.ts'\n" +
  "Using 'pg' driver for database querying\n" +
  "[i] pulling schema from database...\n";

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

  test("db:push that never migrates (rename crash survives recovery) → stage FAILS, never false-greens", async () => {
    // db:push always emits the headless rename crash (exits 0 but never migrated);
    // the gate command itself would be "green". The stage must short-circuit on the
    // failed migration and NOT report the green gate.
    const crash =
      "Error: Interactive prompts require a TTY terminal\n at promptColumnsConflicts";

    const exec: Exec = async (argv) => {
      if (argv[1] === "run" && argv[2] === "db:push") {
        return { code: 0, stdout: "", stderr: crash };
      }

      return { code: 0, stdout: "all good", stderr: "" };
    };

    const stage = boringstackCommandStage("/tmp/clone", exec, [], "bookmark");
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    // Surfaced via #60's db:push error reporter (fingerprinted key, schema-vs-infra guidance).
    expect(r.errors[0]?.rule).toBe("db-push");
    expect(r.errors[0]?.message).toContain("column");
  });

  test("DB oracle: db:push exits 0 but the live table lacks a plan column → stage FAILS (db-schema-mismatch)", async () => {
    // The #204/#200 shape: push "succeeds" but the DB never got `url`. The oracle queries
    // information_schema and must red BEFORE the gate runs on a stale schema.
    const bookmark: IEntityAcceptance = {
      id: "Bookmark",
      key: "bookmark",
      nav: "Bookmarks",
      fields: [
        {
          name: "title",
          type: "string",
          optional: false,
          valid: "t",
          invalid: [],
        },
        {
          name: "url",
          type: "string",
          optional: false,
          valid: "u",
          invalid: [],
        },
      ],
      shows: ["title", "url"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "test bookmark",
    };

    const exec: Exec = async (argv) => {
      // The oracle's information_schema probe: DB has the stub `name`, NOT `url`.
      if (argv[1] === "-e") {
        return {
          code: 0,
          stdout:
            '__ORACLE__["id","user_id","name","title","created_at","updated_at"]',
          stderr: "",
        };
      }

      // db:push and the gate itself both report clean.
      return { code: 0, stdout: "all good", stderr: "" };
    };

    const stage = boringstackCommandStage(
      "/tmp/clone",
      exec,
      [],
      "bookmark",
      bookmark
    );
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors[0]?.rule).toBe("db-schema-mismatch");
    expect(r.errors[0]?.message).toContain("url");
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

  test("a failed db:push is SURFACED (not swallowed) and the gate is NOT run against a stale DB", async () => {
    // #60: db:push's exit code used to be discarded, so a schema-sync failure was silent and
    // the gate ran against an out-of-sync DB. A non-zero push now short-circuits to a gate
    // failure carrying the push output, WITHOUT running the gate.
    const push =
      'Error: column "amount" cannot be cast automatically to type integer';
    const calls: string[] = [];
    const stage = boringstackCommandStage(
      "/tmp/clone",
      execDbPushFails(push, calls)
    );
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);

    const err = r.errors[0];

    expect(err?.rule).toBe("db-push");
    // The key derives from the failure fingerprint, never a constant — so a DIFFERENT error isn't
    // mistaken for "no progress" by stuck detection.
    expect(err?.key.startsWith("db-push:")).toBe(true);
    expect(err?.message).toContain("db:push failed");
    // The raw push output is preserved so the real cause is visible.
    expect(err?.message).toContain("cannot be cast automatically");

    // PROVE the gate was never invoked after the push failed. The command stage runs its setup
    // steps (autofix, then db:push) and, on a push failure, returns immediately — so db:push
    // must be the LAST command executed. Asserting "nothing ran after db:push" is robust to the
    // gate's exact argv shape (a brittle `bash -lc` match would silently pass if that changed).
    expect(calls.some((c) => c.includes("db:push"))).toBe(true);
    expect(calls.at(-1)).toContain("db:push");
  });

  test("does NOT auto-classify schema vs infra — surfaces the raw error + a decision rule, no guessed file", async () => {
    // Repeated review proved schema-vs-infra CANNOT be reliably inferred from the text: Postgres
    // echoes arbitrary identifiers AND unquoted data in error detail — `column "epipe"`, a
    // `DETAIL: Key (name)=(socket hang up) …`, `Failing row contains (1, EPIPE)` — so any token
    // matcher mis-steers real schema/data failures toward "infra / do NOT edit the schema" (the
    // stuck-inducing direction). So the error instead carries the raw output + a decision rule
    // naming BOTH levers and lets the model choose, and sets NO file (guessing app.schema.ts would
    // be wrong for a genuine infra failure).
    const outputs = [
      DRIZZLE_PREAMBLE + 'error: column "amount" does not exist', // schema-shaped
      "Error: connect ECONNREFUSED 127.0.0.1:5432", // infra-shaped
      // Adversarial: a data value that any substring classifier would have flipped to "infra".
      DRIZZLE_PREAMBLE +
        "error: duplicate key value violates unique constraint\n" +
        "DETAIL:  Key (name)=(socket hang up) already exists.",
    ];

    for (const out of outputs) {
      const r = await boringstackCommandStage(
        "/tmp/clone",
        execDbPushFails(out)
      ).run("/tmp/clone");
      const err = r.errors[0];

      expect(err?.key.startsWith("db-push:")).toBe(true);
      // No guessed file — classification is the model's call, from the raw error.
      expect(err?.file).toBeUndefined();
      // The decision rule names BOTH levers (the schema file AND the infra action) every time.
      expect(err?.message).toContain("app.schema.ts");
      expect(err?.message).toContain("dev.sh up");
    }
  });

  test("the key can't be forged by sliding a byte between stdout and stderr (unambiguous serialization)", async () => {
    // Different (stdout, stderr) pairs that would serialize identically under a single-delimiter
    // join must still key differently — otherwise a genuinely different failure reads as "no
    // progress". JSON.stringify([stdout, stderr]) is unforgeable because it escapes EVERY byte.
    const NUL = String.fromCharCode(0);

    const keyFor = async (stdout: string, stderr: string): Promise<string> => {
      const exec: Exec = async (argv) =>
        argv.join(" ").includes("db:push")
          ? { code: 1, stdout, stderr }
          : { code: 0, stdout: "all good", stderr: "" };
      const r = await boringstackCommandStage("/tmp/clone", exec).run(
        "/tmp/clone"
      );

      return r.errors[0]?.key ?? "";
    };

    // A '\n' join collides on these; a NUL join collides on the NUL-carrying pair below.
    expect(await keyFor("a\n", "b")).not.toBe(await keyFor("a", "\nb"));
    // The streams THEMSELVES contain NUL: `a\0`+`b` and `a`+`\0b` both become `a\0\0b` under a
    // NUL join. They must still key differently.
    expect(await keyFor(`a${NUL}`, "b")).not.toBe(await keyFor("a", `${NUL}b`));
  });

  test("the surfaced output is raw (cwd not stripped) and failures differing only by a cwd path stay DISTINCT", async () => {
    // Regression: stripping every `cwd` occurrence collapsed `value=<cwd>` and `value=` to one key
    // and mangled the displayed error. The raw output must be preserved and both key distinctly.
    const cwd = "/tmp/clone";

    const keyAndMsg = async (
      out: string
    ): Promise<{ key: string; message: string }> => {
      const r = await boringstackCommandStage(cwd, execDbPushFails(out)).run(
        cwd
      );

      return {
        key: r.errors[0]?.key ?? "",
        message: r.errors[0]?.message ?? "",
      };
    };

    const withPath = await keyAndMsg(`error: bad default value=${cwd}/x`);
    const withoutPath = await keyAndMsg("error: bad default value=");

    // The cwd is preserved in the surfaced message (raw, not stripped)…
    expect(withPath.message).toContain(cwd);
    // …and the two outputs, which differ ONLY by the cwd occurrence, key differently.
    expect(withPath.key).not.toBe(withoutPath.key);
  });

  test("distinct db:push failures get DISTINCT keys even behind a shared preamble; the same failure is stable", async () => {
    // Stuck detection keys on the error. Real drizzle-kit output opens with a long shared
    // preamble and the distinguishing error is in the TAIL — so a prefix-based key would
    // collapse different failures to "no progress". The key must hash the WHOLE output.
    const preamble =
      "No config path provided, using default 'drizzle.config.ts'\n" +
      "Reading config file '/app/apps/api/drizzle.config.ts'\n" +
      "Using 'pg' driver for database querying\n" +
      "[i] pulling schema from database...\n" +
      "Applying migration to Postgres at postgres://localhost:5432/app ...\n";

    const run = async (out: string): Promise<string> => {
      const r = await boringstackCommandStage(
        "/tmp/clone",
        execDbPushFails(out)
      ).run("/tmp/clone");

      return r.errors[0]?.key ?? "";
    };

    // Two DIFFERENT schema errors sharing the (well over 120-char) preamble.
    const errA =
      preamble + 'PostgreSQL error: column "amount" cannot be cast to integer';
    const errB =
      preamble + 'PostgreSQL error: relation "invoice" already exists';

    const keyA1 = await run(errA);
    const keyA2 = await run(errA);
    const keyB = await run(errB);

    expect(preamble.length).toBeGreaterThan(120); // the exact collision the head-slice caused
    expect(keyA1).toBe(keyA2); // same failure → stable key
    expect(keyA1).not.toBe(keyB); // different failure (only the tail differs) → different key

    // Failures differing ONLY in a digit are genuinely distinct (identifier suffix, type size)
    // and must NOT collapse — masking digits would make them share a key and hide progress.
    const keyD1 = await run(preamble + 'error: column "value1" does not exist');
    const keyD2 = await run(preamble + 'error: column "value2" does not exist');
    const keyV20 = await run(preamble + "error: type varchar(20) too small");
    const keyV30 = await run(preamble + "error: type varchar(30) too small");

    expect(keyD1).not.toBe(keyD2);
    expect(keyV20).not.toBe(keyV30);

    // Postgres quoted identifiers are CASE-SENSITIVE: "value" and "Value" are different
    // columns, so their failures must key differently (a lowercasing normalization collapsed
    // them). The raw-bytes hash preserves case.
    const keyLower = await run(
      preamble + 'error: column "value" does not exist'
    );
    const keyUpper = await run(
      preamble + 'error: column "Value" does not exist'
    );

    expect(keyLower).not.toBe(keyUpper);
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

  test("the REAL abbreviated `Readable<SuccessResponse<...>>` not-assignable error steers to the scaffold unwrap (direct vs `{ data }` envelope), never a cast or infer", () => {
    // Ground truth from build logs: tsc prints the ABBREVIATED form with a literal `...`, e.g.
    // `Type 'Readable<SuccessResponse<...>>' is not assignable to type 'ICompanyItem[]'` — NOT an
    // expanded `{ 200: {} }`. The steer must fire on that real string and give the scaffold's
    // route-shape-dependent unwrap.
    const msg =
      "Type 'Readable<SuccessResponse<...>>' is not assignable to type 'ICompanyItem[]'.";
    const err = signatureToError(
      `failure:apps%2Fui%2Fsrc%2Ffeatures%2Fcompany%2FCompany.queries.ts:14:no-unsafe:${encodeURIComponent(msg)}`
    );

    // It fires on the real abbreviated string and explains the wrapper.
    expect(err.message).toContain("openapi-fetch's response wrapper");
    // The KEY correction: Readable means `data` didn't RESOLVE to the domain type → fix UPSTREAM
    // (schema/path); `?? []`/guard/`as` cannot convert the wrapper. Not a consumer-unwrap fix.
    expect(err.message.toLowerCase()).toContain("did not resolve");
    expect(err.message).toContain("FIX UPSTREAM");
    // The green consumer shapes (for once `data` resolves), keyed to the route.
    expect(err.message).toContain("return data ?? []");
    expect(err.message).toContain("return data.data");
    // Keeps the annotations; forbids the two dead ends the model kept trying (cast / drop annotation).
    expect(err.message).toContain("UseMutationResult<void, unknown, string>");
    expect(err.message).toContain("NEVER `as`");
    expect(err.message.toLowerCase()).toContain("remove the annotation");
    // Must NOT resurrect the fabricated empty-inner / missing-schema-only framing.
    expect(err.message).not.toContain("EMPTY inner");
    expect(err.message).not.toContain("UNIVERSAL");
  });

  test("a generic optional-type mismatch is NOT hijacked by an api-client consumer-unwrap steer (no over-match)", () => {
    // Guard against the reverted over-broad branch: a plain `string | undefined not assignable`
    // (e.g. a PathsWithMethod call-site arg, or any generic optional error) must NOT be steered to
    // "unwrap api-client data / do NOT rewrite the schema" — that mis-directs unrelated errors.
    const msg =
      "Argument of type 'string | undefined' is not assignable to parameter of type 'PathsWithMethod<paths, \"post\">'.";
    const err = signatureToError(
      `failure:apps%2Fui%2Fsrc%2Ffeatures%2Fcontact%2FContact.mutations.ts:14:no-unsafe:${encodeURIComponent(msg)}`
    );

    // It routes to the PathsWithMethod steer (call-site path/verb), NOT an api-client unwrap steer.
    expect(err.message).toContain("PathsWithMethod");
    expect(err.message).not.toContain("do NOT rewrite the schema");
    expect(err.message).not.toContain("value typed OPTIONAL");
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
  // An unreachable-spec fetcher → the runtime route probe is INCONCLUSIVE (non-blocking),
  // so these tests exercise ONLY the static reachability behavior, deterministically.
  const specDown: SpecFetcher = async () => {
    throw new Error("no server");
  };

  test("when feature directory doesn't exist → skips gracefully (no reachability errors)", async () => {
    const stage = reachabilityStage("/nonexistent", "note", specDown);
    const r = await stage.run("/nonexistent");

    // Without the router/API files present, the check can't prove it's unreachable, so it passes
    expect(r.passed).toBe(true);
  });

  test("runtime route-presence: routes ABSENT from the live spec → NOT reachable (kills the #202 source-only false-green)", async () => {
    // Static files absent (so the static check is silent), but the running API's spec does
    // NOT serve the feature's routes → the resource isn't mounted → fail.
    const servesOtherOnly: SpecFetcher = async () => ({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: { "/api/v1/other/": {}, "/api/v1/other/{id}": {} },
    });
    const stage = reachabilityStage("/nonexistent", "note", servesOtherOnly);
    const r = await stage.run("/nonexistent");

    expect(r.passed).toBe(false);
    expect(r.errors[0]?.rule).toBe("reachability");
    expect(r.errors[0]?.message).toContain("/api/v1/note/");
  });

  test("runtime route-presence: routes PRESENT in the live spec → reachable", async () => {
    const servesNote: SpecFetcher = async () => ({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: { "/api/v1/note/": {}, "/api/v1/note/{id}": {} },
    });
    const stage = reachabilityStage("/nonexistent", "note", servesNote);
    const r = await stage.run("/nonexistent");

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

describe("testIdStage — hollow-shell wiring gate (integration, real filesystem)", () => {
  const entity: IEntityAcceptance = {
    id: "Contact",
    key: "contact",
    nav: "Contacts",
    fields: [
      {
        name: "name",
        type: "string",
        optional: false,
        valid: "A",
        invalid: [],
      },
    ],
    shows: ["name"],
    screens: ["list", "form"],
    parents: [],
    negatives: [],
    acceptanceCheck: "create a contact",
  };

  // Every required testid (checkTestIds skips nav) rendered on a real element.
  const ids = testIdsFor(entity.key);
  const allTestIds = [
    ids.list,
    ids.empty,
    ids.create,
    ids.form,
    ids.submit,
    ids.row,
    ids.rowEdit,
    ids.rowDelete,
    ids.confirmDelete,
    ids.field("name"),
    ids.rowCell("name"),
  ];
  const pageWithTestIds = `export const ContactPage = () => (<main>${allTestIds
    .map((t) => `<div data-testid='${t}'></div>`)
    .join("")}</main>);`;

  const QUERIES = "export function useContact() { return []; }";
  const MUTATIONS =
    "export function useCreateContact() {} export function useUpdateContact() {} export function useDeleteContact() {}";

  async function writeFeature(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-wiring-"));

    for (const [rel, src] of Object.entries(files)) {
      const full = join(dir, "apps/ui/src/features/contact", rel);

      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, src);
    }

    return dir;
  }

  test("all testids present but hooks NEVER called → HOLLOW → stage fails (feature-wiring)", async () => {
    const dir = await writeFeature({
      "Contact.queries.ts": QUERIES,
      "Contact.mutations.ts": MUTATIONS,
      "components/ContactPage/ContactPage.tsx": pageWithTestIds,
    });

    try {
      const result = await testIdStage(dir, entity).run(dir);

      expect(result.passed).toBe(false);
      expect(result.errors[0]?.rule).toBe("feature-wiring");
      expect(result.errors[0]?.message).toContain("HOLLOW");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("testids present AND hooks called in the page → passes", async () => {
    const wiredPage = `import { useContact } from "../../Contact.queries";
      import { useCreateContact, useUpdateContact, useDeleteContact } from "../../Contact.mutations";
      export const ContactPage = () => {
        const rows = useContact();
        const c = useCreateContact(); const u = useUpdateContact(); const d = useDeleteContact();
        return (<main>${allTestIds.map((t) => `<div data-testid='${t}'>{rows.map(String)}</div>`).join("")}</main>);
      };`;
    const dir = await writeFeature({
      "Contact.queries.ts": QUERIES,
      "Contact.mutations.ts": MUTATIONS,
      "components/ContactPage/ContactPage.tsx": wiredPage,
    });

    try {
      const result = await testIdStage(dir, entity).run(dir);

      expect(result.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a data-testid in a NON-render .ts does NOT satisfy the testid presence check", async () => {
    // Regression for the gate-relaxed finding: testids must be proven over .tsx, not any .ts.
    const dir = await writeFeature({
      "Contact.queries.ts": `${QUERIES}\n// data-testid='${ids.list}' data-testid='${ids.form}'`,
      "Contact.mutations.ts": MUTATIONS,
      // The .tsx renders NOTHING → testids missing there even though the .ts "contains" them.
      "components/ContactPage/ContactPage.tsx":
        "export const ContactPage = () => <main />;",
    });

    try {
      const result = await testIdStage(dir, entity).run(dir);

      expect(result.passed).toBe(false);
      expect(result.errors[0]?.rule).toBe("testid-presence");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
