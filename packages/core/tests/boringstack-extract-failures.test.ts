import { test, expect, describe } from "bun:test";
import {
  extractFailures,
  novelFailures,
  classifyOpenApiFailure,
} from "../src/loop/boringstack/extract-failures";

describe("extractFailures", () => {
  test("captures bun test failures, stripping timing so signatures are stable", () => {
    const out = `
tests/config/env/validate.test.ts:
(fail) validateEnv > rejects production EMAIL_FROM on a placeholder domain [0.35ms]
 30 pass
 1 fail
`;
    const sigs = extractFailures(out, "/tmp/clone");

    expect(
      sigs.has(
        "failure:tests%2Fconfig%2Fenv%2Fvalidate.test.ts::bun-test:" +
          "(fail)%20validateEnv%20%3E%20rejects%20production%20EMAIL_FROM%20on%20a%20placeholder%20domain"
      )
    ).toBe(true);
    expect(sigs.size).toBe(1);
  });

  test("captures tsc errors and strips the absolute clone path", () => {
    const cwd = "/private/tmp/bs-proof";
    const out = `${cwd}/apps/api/src/api/bookmark/bookmark.service.ts(38,3): error TS2532: Object is possibly 'undefined'.`;
    const sigs = extractFailures(out, cwd);

    expect(
      sigs.has(
        "failure:apps%2Fapi%2Fsrc%2Fapi%2Fbookmark%2Fbookmark.service.ts:38:" +
          "TS2532:Object%20is%20possibly%20'undefined'."
      )
    ).toBe(true);
  });

  test("captures lint-meta blocks with file and rule instead of falling back to gate output", () => {
    const cwd = "/private/tmp/clone";
    const out = `::tsforge-app apps/ui::
[lint:meta] 2 violation(s):

  ${cwd}/apps/ui/src/features/note/Note.queries.ts
    logic-files-require-test-sibling: Missing colocated test. Expected \`src/features/note/Note.queries.test.ts\`.

  ${cwd}/apps/ui/src/features/note/Note.store.ts
    logic-files-require-test-sibling: Missing colocated test. Expected \`src/features/note/Note.store.test.ts\`.

error: script "lint:meta" exited with code 1`;
    const sigs = extractFailures(out, cwd);

    expect(sigs.size).toBe(2);
    expect(
      [...sigs].every(
        (signature) =>
          signature.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures%2Fnote") &&
          signature.includes("logic-files-require-test-sibling")
      )
    ).toBe(true);
  });

  test("carries the preceding eslint file header into the failure signature", () => {
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/tests/api/note/note.routes.test.ts
  68:10  error  Define a constant instead of duplicating this literal 5 times  sonarjs/no-duplicate-string`;
    const sigs = extractFailures(out, cwd);
    const signature = [...sigs][0] ?? "";

    expect(signature).toContain(
      "failure:apps%2Fapi%2Ftests%2Fapi%2Fnote%2Fnote.routes.test.ts:68:sonarjs%2Fno-duplicate-string"
    );
  });

  test("captures the FULL multi-line eslint message (rule + fix), not just its truncated first line", () => {
    // The EXACT stylish shape that ground a live build near-green: the model saw only
    // "…detected in module:" (no categories, no fix) and sprayed. The parser must
    // stitch the continuation lines + the trailing ruleId into one signature.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/bookmark/bookmark.service.ts
  6:8  error  Mixed semantic categories detected in module:
- function
- class

A module must contain only one semantic concern.
Move declarations into separate files/modules  module-boundaries/single-semantic-module`;
    const sigs = extractFailures(out, cwd);
    const signature = [...sigs][0] ?? "";

    // Rule id captured (enables rule-help), file + line correct…
    expect(signature).toContain(
      "failure:apps%2Fapi%2Fsrc%2Fapi%2Fbookmark%2Fbookmark.service.ts:6:module-boundaries%2Fsingle-semantic-module"
    );
    // …and the ACTIONABLE detail survives (categories + the fix), decoded.
    const decoded = decodeURIComponent(signature);

    expect(decoded).toContain("- function");
    expect(decoded).toContain("- class");
    expect(decoded).toContain("Move declarations into separate files");
    // Exactly one signature — the continuation lines didn't leak as junk rows.
    expect(sigs.size).toBe(1);
  });

  test("a rule-less parse error does NOT swallow the next file's header + diagnostics (join stops at boundaries)", () => {
    // The regression the join must avoid: a `Parsing error` carries no ruleId, so a
    // greedy join would absorb every following line — losing file B's header and
    // mis-attributing its error to file A. The join must stop at the next file header.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  1:1  error  Parsing error: ';' expected
${cwd}/apps/api/src/api/b/b.ts
  2:3  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // Two DISTINCT signatures, each attributed to its OWN file.
    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:1:syntax")
      )
    ).toBe(true);
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fb%2Fb.ts:2:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("drops the parserOptions.project fan-out NOISE from a real syntax break, keeping the located break", () => {
    // When ONE file has a real syntax break, the type-aware ESLint program fails to
    // build and reports a `parserOptions.project` parse error on EVERY other .tsx —
    // pure noise that inflates a near-green build 1→N and thrashes the oscillation
    // logic. Those siblings are dropped; the REAL break stays its own located signature
    // (correct file → correct phase) so the model knows which file to rewrite. NO global
    // token is minted (nothing can enter the baseline and hide a later failure).
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/ui/src/features/ticket/Ticket.mutations.test.tsx
  12:3  error  Parsing error: '}' expected
${cwd}/apps/ui/src/features/ticket/Ticket.queries.test.tsx
  1:1  error  Parsing error: ESLint was configured to run on \`<tsconfigRootDir>/src/features/ticket/Ticket.queries.test.tsx\` using \`parserOptions.project\`: tsconfig.json
${cwd}/apps/ui/src/features/ticket/Ticket.hooks.ts
  1:1  error  Parsing error: ESLint was configured to run on \`<tsconfigRootDir>/src/features/ticket/Ticket.hooks.ts\` using \`parserOptions.project\`: tsconfig.json
${cwd}/apps/ui/src/features/ticket/TicketPage.tsx
  1:1  error  Parsing error: ESLint was configured to run on \`<tsconfigRootDir>/src/features/ticket/TicketPage.tsx\` using \`parserOptions.project\`: tsconfig.json`;
    const sigs = extractFailures(out, cwd);

    // The located real syntax break survives...
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fui%2Fsrc%2Ffeatures%2Fticket%2FTicket.mutations.test.tsx:12:syntax"
        )
      )
    ).toBe(true);
    // ...the 3 parserOptions siblings are dropped, and no global token is minted...
    expect([...sigs].some((s) => s.includes("parserOptions"))).toBe(false);
    expect([...sigs].some((s) => s.includes("eslint-program-unparsable"))).toBe(
      false
    );
    // ...so the count is 1 (the broken file), NOT 4.
    expect(sigs.size).toBe(1);
  });

  test("KEEPS genuine parserOptions errors located when there is NO syntax break (not a cascade)", () => {
    // Two independent 'file not in tsconfig' errors with no real syntax break are NOT a
    // cascade — they are real, per-file, actionable config problems. They must keep their
    // files (→ correct phase) and messages, never be dropped or globbed.
    const cwd = "/tmp/clone";
    const cfg = "using parserOptions.project: tsconfig.json";
    const out = `${cwd}/apps/api/src/api/x/x.ts
  1:1  error  Parsing error: ESLint was configured to run on x.ts ${cfg}
${cwd}/apps/ui/src/features/y/y.ts
  1:1  error  Parsing error: ESLint was configured to run on y.ts ${cfg}`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fx%2Fx.ts:1:syntax")
      )
    ).toBe(true);
    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures%2Fy%2Fy.ts:1:syntax")
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("drops the cascade noise in the JSON path too (both eslint paths, one post-pass)", () => {
    // The gate emits eslint as JSON blocks in production; the drop runs on the final
    // signature set, so a JSON cascade is handled just like the stylish one.
    const cwd = "/tmp/clone";
    const base = "apps/ui/src/features/task";
    const cfg =
      "ESLint was configured to run on X using parserOptions.project: tsconfig.json";
    const out = `::tsforge-eslint-json apps/ui::
[{"filePath":"${cwd}/${base}/Task.mutations.test.tsx","messages":[{"ruleId":null,"severity":2,"message":"Parsing error: '}' expected","line":12,"column":3}]},{"filePath":"${cwd}/${base}/Task.queries.test.tsx","messages":[{"ruleId":null,"severity":2,"message":"Parsing error: ${cfg}","line":1,"column":1}]},{"filePath":"${cwd}/${base}/Task.hooks.ts","messages":[{"ruleId":null,"severity":2,"message":"Parsing error: ${cfg}","line":1,"column":1}]}]
::tsforge-eslint-json-end::`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FTask.mutations.test.tsx:12:syntax"
        )
      )
    ).toBe(true);
    expect([...sigs].some((s) => s.includes("parserOptions"))).toBe(false);
    expect(sigs.size).toBe(1);
  });

  test("two single-line eslint errors in ONE file stay separate (a following error is a boundary, never fused)", () => {
    // The exact hole the conservative join must close: a bare CORE-rule error (no
    // slash in its id) is not "complete" under the terminator check, so it must NOT
    // open a join that swallows the NEXT (@typescript-eslint) error row.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  3:1  error  Expected '===' and instead saw '=='  eqeqeq
  4:7  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:3:eqeqeq")
      )
    ).toBe(true);
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:4:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("an INCOMPLETE multi-line open is NOT fused with a following plugin-qualified error (the boundary-terminator guard)", () => {
    // The actual hole the guard closes: an open row (no ruleId on line 1, ends with
    // `:`) immediately followed by a complete plugin-qualified error. The following
    // error is a boundary AND matches the ruleId pattern — it must NOT be consumed as
    // this open's terminator.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  3:8  error  Mixed semantic categories detected in module:
  9:1  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // The open row stays its OWN signature (unterminated → truncated first line, NOT
    // fused) — it must NOT carry the following error's rule id.
    expect(
      [...sigs].some(
        (s) =>
          decodeURIComponent(s).includes("Mixed semantic categories") &&
          !s.includes("no-explicit-any")
      )
    ).toBe(true);
    // …and the following error remains a SEPARATE, correctly-attributed signature.
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:9:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("a following WARNING row is a boundary, not a terminator (not fused into the error)", () => {
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  3:8  error  Mixed semantic categories detected in module:
  9:1  warning  Prefer const  sonarjs/prefer-const`;
    const sigs = extractFailures(out, cwd);

    // The error's (truncated) signature must NOT carry the warning's rule id — the
    // warning row is a boundary, and warnings aren't captured as failures at all.
    expect([...sigs].some((s) => s.includes("prefer-const"))).toBe(false);
    expect(
      [...sigs].some((s) =>
        decodeURIComponent(s).includes("Mixed semantic categories")
      )
    ).toBe(true);
  });

  test("a multi-line message whose BODY ends in a .ts path still joins (no abort, no currentFile corruption)", () => {
    // A prose line ENDING in `.ts` (`Move the type into a.types.ts`) is NOT a bare-path
    // file header — it must not abort the join nor be promoted to currentFile. The join
    // reaches its real terminator; the NEXT file's error attributes to the NEXT file.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  6:8  error  Mixed semantic categories detected in module:
- type
- schema
Move the type into a.types.ts
Move declarations into separate files/modules  module-boundaries/single-semantic-module
${cwd}/apps/api/src/api/b/b.ts
  2:1  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // a.ts joined to its real terminator (rule id captured; prose body survives).
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:6:module-boundaries%2Fsingle-semantic-module"
        )
      )
    ).toBe(true);
    // b.ts's error attributes to b.ts — NOT to `a.types.ts` from the prose body.
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fb%2Fb.ts:2:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    // No signature is ATTRIBUTED to the prose path (that would be currentFile
    // corruption); the prose may appear inside a message, but never as a file.
    expect([...sigs].some((s) => s.startsWith("failure:a.types.ts"))).toBe(
      false
    );
    expect(sigs.size).toBe(2);
  });

  test("an unterminated eslint open does NOT swallow an interleaved tsc/bun failure", () => {
    // Interleaved gate output: an eslint multi-line-looking open (no plugin terminator)
    // followed by a tsc error then a bun (fail). The join must stop at each — never
    // absorb them — so the outer parser still sees all three failures.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/a/a.ts
  6:8  error  Some message with no ruleId on this line:
${cwd}/apps/api/src/api/a/a.service.ts(4,3): error TS2532: Object is possibly 'undefined'.
tests/api/a/a.service.test.ts:
(fail) aService > creates [0.2ms]`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) => s.includes("TS2532") || s.includes("2532"))
    ).toBe(true);
    expect(
      [...sigs].some((s) => decodeURIComponent(s).includes("(fail)"))
    ).toBe(true);
    // The eslint open is still its own (truncated) signature — nothing was fused.
    expect(
      [...sigs].some((s) => decodeURIComponent(s).includes("no ruleId on this"))
    ).toBe(true);
  });

  test("a single-line eslint row is unaffected by the multi-line join", () => {
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/x/x.ts
  6:1  error  Expected blank line before this statement  padding-line-between-statements`;
    const sigs = extractFailures(out, cwd);
    const signature = [...sigs][0] ?? "";

    expect(signature).toContain(
      "failure:apps%2Fapi%2Fsrc%2Fapi%2Fx%2Fx.ts:6:padding-line-between-statements"
    );
    expect(sigs.size).toBe(1);
  });

  test("an eslint PARSING error is captured as `syntax`, not the message's last word", () => {
    // A parsing-error row carries no ruleId; after normalize() collapses the
    // message↔ruleId gap the generic row regex would grab `expected` (the last
    // word of `… ';' expected`) and mint a phantom rule that later poisons mined
    // lessons. It must be tagged `syntax` (the tsc-parser convention) instead.
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/note/note.routes.ts
  12:5  error  Parsing error: ';' expected`;
    const sigs = extractFailures(out, cwd);
    const signature = [...sigs][0] ?? "";

    expect(signature).toContain(
      "failure:apps%2Fapi%2Fsrc%2Fapi%2Fnote%2Fnote.routes.ts:12:syntax"
    );
    expect(signature).not.toContain(":expected:");
  });

  test("a generate:api FAILED line becomes a clear, STABLE openapi-unreachable infra signature (not opaque)", () => {
    const out =
      "::tsforge-app apps/ui::\n" +
      "[generate:api] Fetching http://localhost:62306/swagger/json\n" +
      "[generate:api] FAILED: fetch failed (ECONNREFUSED)\n" +
      "[generate:api] Hint: start apps/api or set OPENAPI_URL to a reachable spec.";
    const sigs = extractFailures(out, "/tmp/clone");
    const sig =
      [...sigs].find((s) => s.startsWith("openapi-unreachable:")) ?? "";

    // The signature has NO file component (prefix is `openapi-unreachable:`, not
    // `failure:<file>:…`) so it maps to a file-less "own" error the model sees, not
    // an out-of-scope/locked-file diagnostic. The suffix is a STABLE failure CLASS
    // (not the raw prose) so the fingerprint doesn't drift with the wording.
    expect(sig).toBe("openapi-unreachable:connection-refused");
    expect(sig).not.toStartWith("failure:");
    expect(sig).not.toContain("gate-nonzero");
  });

  describe("classifyOpenApiFailure", () => {
    test("maps distinct wordings of the same infra class to one stable token", () => {
      expect(classifyOpenApiFailure("fetch failed (ECONNREFUSED)")).toBe(
        "connection-refused"
      );
      expect(classifyOpenApiFailure("The operation timed out")).toBe("timeout");
      expect(classifyOpenApiFailure("getaddrinfo ENOTFOUND api")).toBe("dns");
      expect(classifyOpenApiFailure("responded with 503 Service")).toBe(
        "http-503"
      );
      expect(classifyOpenApiFailure("something weird happened")).toBe(
        "unreachable"
      );
    });
  });

  test("captures eslint error rows but ignores passing/summary noise", () => {
    const out = `
  12:10  error  Unexpected any  @typescript-eslint/no-explicit-any
 ✓ some passing thing
 30 pass
`;
    const sigs = extractFailures(out, "/x");

    expect(
      sigs.has("12:10 error Unexpected any @typescript-eslint/no-explicit-any")
    ).toBe(true);
    expect(sigs.size).toBe(1);
  });

  test("structured eslint JSON → exact signatures; stylish rows for the same run are ignored (no double)", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/api/a/a.ts","messages":[{"ruleId":"module-boundaries/single-semantic-module","severity":2,"message":"Mixed semantic categories detected in module:\\n- type\\n- schema\\nMove declarations into separate files/modules","line":6,"column":8},{"ruleId":"@typescript-eslint/no-explicit-any","severity":2,"message":"Unexpected any.","line":9,"column":3},{"ruleId":"prefer-const","severity":1,"message":"just a warning","line":1,"column":1}]}]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/api/a/a.ts
  6:8  error  Mixed semantic categories detected in module:
- type
- schema
Move declarations into separate files/modules  module-boundaries/single-semantic-module
  9:3  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // Exact structured signatures from JSON (full multi-line message, correct rule).
    const semantic = [...sigs].find((s) =>
      s.includes("single-semantic-module")
    );

    expect(semantic).toBeDefined();
    expect(semantic).toStartWith(
      "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:6:module-boundaries%2Fsingle-semantic-module"
    );
    expect(decodeURIComponent(semantic ?? "")).toContain(
      "Move declarations into separate files"
    );
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:9:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    // Warning (severity 1) is NOT a failure.
    expect([...sigs].some((s) => s.includes("prefer-const"))).toBe(false);
    // Exactly the two errors — the stylish rows did NOT create duplicates.
    expect(sigs.size).toBe(2);
  });

  test("scopes the drop by APP — a break in one app never deletes another app's genuine parserOptions errors", () => {
    const cwd = "/tmp/clone";
    const cfg = "using parserOptions.project: tsconfig.json";
    const out = `${cwd}/apps/ui/src/features/z/Z.tsx
  4:2  error  Parsing error: '}' expected
${cwd}/apps/ui/src/features/z/Z.hooks.ts
  1:1  error  Parsing error: ESLint was configured to run on Z.hooks.ts ${cfg}
${cwd}/apps/api/src/api/w/w.ts
  1:1  error  Parsing error: ESLint was configured to run on w.ts ${cfg}`;
    const sigs = extractFailures(out, cwd);

    // apps/ui has the break → its parserOptions sibling is cascade noise, dropped...
    expect([...sigs].some((s) => s.includes("Z.hooks.ts"))).toBe(false);
    // ...the located ui break stays...
    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures%2Fz%2FZ.tsx:4:syntax")
      )
    ).toBe(true);
    // ...but apps/api (no break there) KEEPS its genuine parserOptions error.
    expect(
      [...sigs].some((s) =>
        s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fw%2Fw.ts:1:syntax")
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("a tsc-only syntax error does NOT drop parserOptions siblings (the eslint `Parsing error:` is the cascade signal)", () => {
    // If a file is truly unparsable, eslint itself emits a `Parsing error:` — that is the
    // reliable cascade signal. A tsc TS#### with no eslint parse error is not treated as a
    // cascade, so the parserOptions errors are KEPT (locked keep-noise behavior).
    const cwd = "/tmp/clone";
    const out = `${cwd}/apps/api/src/api/x/x.ts(3,10): error TS1005: ',' expected.
${cwd}/apps/api/src/api/y/y.ts
  1:1  error  Parsing error: ESLint was configured to run on y.ts using parserOptions.project: tsconfig.json`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) => s.includes("y.ts") && s.includes(":syntax:"))
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("a JSON message containing `error TS…` is not mis-parsed as a tsc diagnostic", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/x.ts","messages":[{"ruleId":"no-console","severity":2,"message":"Do not mention error TS2532 here","line":2,"column":1}]}]
::tsforge-eslint-json-end::`;
    const sigs = extractFailures(out, cwd);

    expect(sigs.size).toBe(1);
    expect([...sigs][0]).toStartWith(
      "failure:apps%2Fapi%2Fsrc%2Fx.ts:2:no-console"
    );
    // The `error TS2532` inside the message did NOT mint a phantom tsc signature.
    expect([...sigs].some((s) => s.includes("TS2532:"))).toBe(false);
  });

  test("tsc + bun failures still parse alongside a JSON eslint block", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/x.ts","messages":[{"ruleId":"no-console","severity":2,"message":"no console","line":2,"column":1}]}]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/y.ts(38,3): error TS2532: Object is possibly 'undefined'.
tests/api/z/z.test.ts:
(fail) zService > works [0.2ms]`;
    const sigs = extractFailures(out, cwd);

    expect([...sigs].some((s) => s.includes("no-console"))).toBe(true);
    expect([...sigs].some((s) => s.includes("TS2532"))).toBe(true);
    expect(
      [...sigs].some((s) => decodeURIComponent(s).includes("(fail)"))
    ).toBe(true);
  });

  test("a malformed JSON block falls back to scraping stylish eslint (no lint error lost)", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-eslint-json apps/api::
not valid json {[
::tsforge-eslint-json-end::
${cwd}/apps/api/src/x.ts
  4:2  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // JSON unparseable → stylish path still captures the eslint error.
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fx.ts:4:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
  });

  test("API JSON `[]` (green) does NOT suppress UI's stylish errors when the UI block is malformed", () => {
    // The gate emits TWO blocks (api, ui). API is green ([]) and UI's block is malformed
    // → neither contributes dedup keys, so UI's stylish eslint error must still be
    // captured (a global suppression flag would have lost it — the near-green regression).
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[]
::tsforge-eslint-json-end::
::tsforge-app apps/ui::
::tsforge-eslint-json apps/ui::
not valid json {[
::tsforge-eslint-json-end::
${cwd}/apps/ui/src/features/x/X.tsx
  4:2  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fui%2Fsrc%2Ffeatures%2Fx%2FX.tsx:4:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
  });

  test("a wrong-shaped JSON array (`[1,2,3]`) yields no dedup keys — stylish is still scraped", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[1,2,3]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/x.ts
  4:2  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fx.ts:4:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
  });

  test("a valid-shaped block whose message entries are malformed yields no dedup keys (stylish still scraped)", () => {
    // `[{filePath, messages:[{}]}]` is a valid array but the {} message has no
    // severity 2, so it contributes ZERO dedup keys. The stylish error is therefore
    // still captured — the panel's "shape-valid but incomplete payload silently loses
    // lint" finding, resolved by per-error dedup rather than per-app suppression.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/x.ts","messages":[{}]}]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/x.ts
  4:2  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fx.ts:4:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
  });

  test("an unterminated JSON block never swallows later diagnostics (only CLOSED blocks are stripped)", () => {
    // The API JSON block is missing its end marker (truncated/killed capture). Only
    // CLOSED blocks are stripped from the scanned text; an unterminated one is left in
    // place and parsed line-by-line — its partial JSON line is not an error row, so it
    // is skipped harmlessly, and the UI's tsc error that follows is still captured. A
    // sticky skip flag would have swallowed every later line.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/x.ts","messages":[
::tsforge-app apps/ui::
${cwd}/apps/ui/src/features/x/x.ts(10,5): error TS2532: Object is possibly 'undefined'.`;
    const sigs = extractFailures(out, cwd);

    expect([...sigs].some((s) => s.includes("TS2532"))).toBe(true);
    expect(
      [...sigs].some((s) => s.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures"))
    ).toBe(true);
  });

  test("an unterminated block does NOT pair with a LATER closed block (no cross-block strip)", () => {
    // The tempered regex must stop the API block's content at the UI opening marker.
    // A naive `[\s\S]*?` would pair the unterminated API opening with the UI closing and
    // strip everything between — losing the intervening tsc error AND the UI JSON error.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/api/x.ts","messages":[
${cwd}/apps/api/src/api/x.ts(5,3): error TS1005: ';' expected.
::tsforge-app apps/ui::
::tsforge-eslint-json apps/ui::
[{"filePath":"${cwd}/apps/ui/src/features/y/y.ts","messages":[{"ruleId":"no-console","severity":2,"message":"no console","line":2,"column":1}]}]
::tsforge-eslint-json-end::`;
    const sigs = extractFailures(out, cwd);

    // The tsc error between the two blocks survives (API block was NOT stripped)…
    expect([...sigs].some((s) => s.includes("TS1005"))).toBe(true);
    // …and the CLOSED UI block still parses to its structured signature.
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fui%2Fsrc%2Ffeatures%2Fy%2Fy.ts:2:no-console"
        )
      )
    ).toBe(true);
  });

  test("column is in the dedup key: a stylish error at a different column on the same line/rule is NOT dropped", () => {
    // JSON reports ONE no-console at 6:3; stylish has that one PLUS a second no-console at
    // 6:20 the JSON never emitted. With column in the dedup key, only the 6:3 twin is
    // deduped and 6:20 survives. A column-less key (file:line:rule) would drop BOTH
    // stylish rows and silently lose the 6:20 error.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/api/a/a.ts","messages":[{"ruleId":"no-console","severity":2,"message":"a","line":6,"column":3}]}]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/api/a/a.ts
  6:3  error  a  no-console
  6:20  error  b  no-console`;
    const sigs = extractFailures(out, cwd);
    const consoleErrors = [...sigs].filter((s) =>
      s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:6:no-console")
    );

    // The JSON error (6:3) and the stylish-only error (6:20) — two distinct signatures.
    expect(consoleErrors).toHaveLength(2);
  });

  test("a JSON error at one line does NOT suppress a stylish-only error at another (per-error dedup, not per-app)", () => {
    // The panel's core finding: if the JSON is a SUBSET of the real lint failures, a
    // per-app suppression would drop the stylish-only errors. Per-(file,line,rule) dedup
    // drops only the exact error the JSON already reported (a.ts:6), keeping the
    // stylish-only error at a.ts:9 that the JSON never emitted.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/api::
::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/api/a/a.ts","messages":[{"ruleId":"no-console","severity":2,"message":"no console","line":6,"column":8}]}]
::tsforge-eslint-json-end::
${cwd}/apps/api/src/api/a/a.ts
  6:8  error  no console  no-console
  9:3  error  Unexpected any  @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, cwd);

    // The JSON error (line 6) is kept exactly once — its stylish duplicate is deduped.
    expect(
      [...sigs].filter((s) =>
        s.startsWith("failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:6:no-console")
      )
    ).toHaveLength(1);
    // The stylish-ONLY error (line 9) — never in the JSON — is still captured.
    expect(
      [...sigs].some((s) =>
        s.startsWith(
          "failure:apps%2Fapi%2Fsrc%2Fapi%2Fa%2Fa.ts:9:%40typescript-eslint%2Fno-explicit-any"
        )
      )
    ).toBe(true);
    expect(sigs.size).toBe(2);
  });

  test("a multi-line JSON message is whitespace-collapsed so its signature matches the stylish path", () => {
    // Same error, two sources: the JSON message carries literal newlines, the stylish
    // row is space-joined. Both must key to the SAME signature — else a JSON block that
    // intermittently fails to parse would make a pre-existing failure look novel in the
    // differential. Assert the JSON signature has NO encoded newline (%0A) and DOES
    // contain the full space-joined message.
    const cwd = "/tmp/clone";
    const out = `::tsforge-eslint-json apps/api::
[{"filePath":"${cwd}/apps/api/src/x.ts","messages":[{"ruleId":"module-boundaries/single-semantic-module","severity":2,"message":"Mixed categories:\\n- type\\n- schema","line":6,"column":8}]}]
::tsforge-eslint-json-end::`;
    const sigs = extractFailures(out, cwd);
    const sig = [...sigs][0] ?? "";

    expect(sig).not.toContain("%0A");
    expect(decodeURIComponent(sig)).toContain(
      "Mixed categories: - type - schema"
    );
  });

  test("parses a LARGE (~1MB) realistic gate output in well under a second (ReDoS regression guard)", () => {
    // A prior tempered-quantifier regex (`(?:(?!open)[\\s\\S])*?`) backtracked O(n²)+
    // and hung the whole gate for minutes on real ~1MB output — tiny fixtures hid it.
    const cwd = "/tmp/clone";
    const chunk =
      `::tsforge-app apps/api::\n` +
      `::tsforge-eslint-json apps/api::\n` +
      `[{"filePath":"${cwd}/apps/api/src/f.ts","messages":[]}]\n` +
      `::tsforge-eslint-json-end::\n` +
      `${cwd}/apps/api/src/f.ts(3,3): error TS2532: Object is possibly 'undefined'.\n` +
      `tests/api/a/a.test.ts:\n(fail) svc > works [0.2ms]\n` +
      ` 100 pass\n 1 fail\n`;
    const out = chunk.repeat(4000); // ~1MB+

    const started = Date.now();
    const sigs = extractFailures(out, cwd);

    expect(Date.now() - started).toBeLessThan(2000);
    // Still correct: the tsc error is captured (deduped across identical chunks).
    expect([...sigs].some((s) => s.includes("TS2532"))).toBe(true);
  });

  test("stays fast with MANY opening markers and NO end markers (the O(n²) per-open trap)", () => {
    // The pathological input the merge scan must handle: thousands of UNTERMINATED
    // `::tsforge-eslint-json <app>::` openings and no end marker. A per-opening
    // `indexOf(END, …)` would rescan to EOF for every one → O(n²). The forward-only
    // end-pointer merge keeps it O(n). Also asserts no block is wrongly closed.
    const cwd = "/tmp/clone";
    const open = `::tsforge-eslint-json apps/api::\n[{"filePath":"x"}]\n`;
    const out = open.repeat(20000); // ~1MB of openings, zero end markers

    const started = Date.now();
    const sigs = extractFailures(out, cwd);

    expect(Date.now() - started).toBeLessThan(2000);
    // No end markers → no closed blocks parsed, nothing spuriously matched.
    expect(sigs.size).toBe(0);
  });

  test("a long non-space run after an opener with no closer stays fast (\\S+:: backtracking guard)", () => {
    // The precise catastrophic shape: `::tsforge-eslint-json ` then a long unbroken
    // non-space run and NO closing `::`. A `(\\S+)::` app token would backtrack O(n²)
    // trying every split for the missing `::`. `[^\\s:]+` stops dead at the first colon,
    // so there is nothing to backtrack. Assert it parses near-instantly.
    const out = `::tsforge-eslint-json ${"a".repeat(300000)}\nno end marker here`;

    const started = Date.now();
    const sigs = extractFailures(out, "/tmp/clone");

    expect(Date.now() - started).toBeLessThan(2000);
    expect(sigs.size).toBe(0);
  });

  test("parses a vitest suite-load FAIL (vi.mock hoisting): Caused-by root cause wins, verbatim", () => {
    // The EXACT gate-parity failure, with REAL vitest 4 output: a long generic Error line
    // (with a URL) FIRST, then the `Caused by:` root cause. The root cause must win and be
    // captured VERBATIM (no truncation — house rule).
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/hooks/useTasks.test.tsx [ src/features/task/hooks/useTasks.test.tsx ]
Error: [vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file. Read more: https://vitest.dev/api/vi.html#vi-mock
Caused by: ReferenceError: Cannot access 'mockGet' before initialization`;
    const sigs = extractFailures(out, cwd);
    const vitest = [...sigs].find((s) => s.includes(":vitest:"));

    expect(vitest).toBeDefined();
    expect(vitest).toStartWith(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2Fhooks%2FuseTasks.test.tsx::vitest:"
    );
    // The ROOT cause (Caused by) is captured, in FULL — not the generic first line, and
    // not truncated mid-word.
    const decoded = decodeURIComponent(vitest ?? "");

    expect(decoded).toContain(
      "Caused by: ReferenceError: Cannot access 'mockGet' before initialization"
    );
  });

  test("a bare-file vitest FAIL does NOT leak across an app boundary (no cross-app contamination)", () => {
    // A UI suite-load FAIL with no detail line before the next ::tsforge-app marker. The
    // pending file must be flushed to apps/ui at the boundary — the api error line that
    // follows must NOT be attributed to the ui test file.
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/hooks/useTasks.test.tsx [ src/features/task/hooks/useTasks.test.tsx ]
::tsforge-app apps/api::
${cwd}/apps/api/src/x.ts(3,3): error TS2532: Object is possibly 'undefined'.`;
    const sigs = extractFailures(out, cwd);
    const vitest = [...sigs].find((s) => s.includes(":vitest:")) ?? "";

    // The vitest signature is attributed to apps/ui and carries a generic (not api) detail.
    expect(vitest).toStartWith(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2Fhooks%2FuseTasks.test.tsx::vitest:"
    );
    expect(decodeURIComponent(vitest)).toContain("test suite failed to load");
    // The api tsc error is its OWN signature, not swallowed as the ui test's detail.
    expect([...sigs].some((s) => s.includes("TS2532"))).toBe(true);
  });

  test("parses a named vitest test FAIL: keeps the test name AND its AssertionError body", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/TaskList.test.tsx > TaskList > renders empty state
AssertionError: expected element to be in the document`;
    const sigs = extractFailures(out, cwd);
    const vitest = [...sigs].find((s) =>
      s.startsWith(
        "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FTaskList.test.tsx::vitest:"
      )
    );

    expect(vitest).toBeDefined();
    const decoded = decodeURIComponent(vitest ?? "");

    expect(decoded).toContain("renders empty state");
    expect(decoded).toContain(
      "AssertionError: expected element to be in the document"
    );
  });

  test("keeps a parameterized test's [param] suffix so distinct cases stay distinct", () => {
    const cwd = "/tmp/clone";
    const mobile = `::tsforge-app apps/ui::\n FAIL  src/features/task/TaskList.test.tsx > renders [mobile]`;
    const desktop = `::tsforge-app apps/ui::\n FAIL  src/features/task/TaskList.test.tsx > renders [desktop]`;
    const a =
      [...extractFailures(mobile, cwd)].find((s) => s.includes(":vitest:")) ??
      "";
    const b =
      [...extractFailures(desktop, cwd)].find((s) => s.includes(":vitest:")) ??
      "";

    expect(decodeURIComponent(a)).toContain("[mobile]");
    expect(decodeURIComponent(b)).toContain("[desktop]");
    expect(a).not.toBe(b); // different params → different signatures, not a collision
  });

  test("captures an Error-only suite-load failure (no Caused by), e.g. SyntaxError", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/Task.utils.test.ts [ src/features/task/Task.utils.test.ts ]
SyntaxError: Unexpected token '}'`;
    const vitest =
      [...extractFailures(out, cwd)].find((s) => s.includes(":vitest:")) ?? "";

    expect(vitest).toStartWith(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FTask.utils.test.ts::vitest:"
    );
    expect(decodeURIComponent(vitest)).toContain(
      "SyntaxError: Unexpected token '}'"
    );
  });

  test("captures a BASE `Error:` suite-load line (no Caused by) — not just prefixed *Errors", () => {
    // The vi.mock message starts with a bare `Error: [vitest] …`; if no `Caused by:`
    // follows, that line MUST still be captured (a prior regex required a char before
    // "Error" and dropped it, flushing a useless "test suite failed to load").
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/hooks/useTasks.test.tsx [ src/features/task/hooks/useTasks.test.tsx ]
Error: [vitest] There was an error when mocking a module.`;
    const vitest =
      [...extractFailures(out, cwd)].find((s) => s.includes(":vitest:")) ?? "";

    expect(decodeURIComponent(vitest)).toContain(
      "Error: [vitest] There was an error"
    );
    expect(decodeURIComponent(vitest)).not.toContain(
      "test suite failed to load"
    );
  });

  test("two sequential vitest FAILs each flush with their OWN detail (flush-on-next-FAIL)", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/A.test.tsx > A > one
AssertionError: expected 1 to be 2
 FAIL  src/features/task/B.test.tsx > B > two
AssertionError: expected 3 to be 4`;
    const sigs = [...extractFailures(out, cwd)];
    const a =
      sigs.find((s) =>
        s.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FA.test.tsx")
      ) ?? "";
    const b =
      sigs.find((s) =>
        s.startsWith("failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FB.test.tsx")
      ) ?? "";

    expect(decodeURIComponent(a)).toContain("expected 1 to be 2");
    expect(decodeURIComponent(b)).toContain("expected 3 to be 4");
    // Details didn't cross-contaminate.
    expect(decodeURIComponent(a)).not.toContain("expected 3");
  });

  test("parses a .spec.ts vitest FAIL (not just .test.*)", () => {
    const cwd = "/tmp/clone";
    const out = `::tsforge-app apps/ui::
 FAIL  src/features/task/Task.spec.ts > does a thing`;
    const vitest =
      [...extractFailures(out, cwd)].find((s) => s.includes(":vitest:")) ?? "";

    expect(vitest).toStartWith(
      "failure:apps%2Fui%2Fsrc%2Ffeatures%2Ftask%2FTask.spec.ts::vitest:"
    );
  });

  test("a passing vitest summary yields no vitest signatures", () => {
    const out =
      "::tsforge-app apps/ui::\n Test Files  129 passed (129)\n      Tests  413 passed (413)";

    expect(
      [...extractFailures(out, "/tmp/clone")].some((s) =>
        s.includes(":vitest:")
      )
    ).toBe(false);
  });

  test("a fully green run yields no signatures", () => {
    expect(extractFailures("30 pass\n0 fail\nDone.", "/x").size).toBe(0);
  });

  test("captures a knip 'Unused files' entry as an actionable signature (the live wall)", () => {
    // The EXACT shape that ground a real run for 130+ turns: knip flagged a
    // co-located API test as unused, but it collapsed into an opaque fallback.
    const out = `[generate:lint-meta-docs] RULES.md is up to date.
Unused files (1)
src/api/note/note.service.test.ts
$ bun run check && bun run test
$ tsc --noEmit`;
    const sigs = extractFailures(out, "/tmp/clone");

    expect(sigs.has("knip:unused-file:src/api/note/note.service.test.ts")).toBe(
      true
    );
    expect(sigs.size).toBe(1);
  });

  test("app-qualifies a knip path using the ::tsforge-app:: stage marker (repo-relative for scope matching)", () => {
    // The exact live shape: knip runs inside apps/api and prints a src-relative path.
    // Without the app prefix the path wouldn't match the model's editable scope and
    // the loop would drop it as read-only.
    const out = `::tsforge-app apps/api::
[generate:lint-meta-docs] RULES.md is up to date.
Unused files (1)
src/api/note/note.service.test.ts
$ bun run check`;
    const sigs = extractFailures(out, "/tmp/clone");

    expect(
      sigs.has("knip:unused-file:apps/api/src/api/note/note.service.test.ts")
    ).toBe(true);
    expect(sigs.size).toBe(1);
  });

  test("captures MULTIPLE knip unused files and stops at the command echo", () => {
    const out = `Unused files (2)
src/api/note/note.service.test.ts
src/lib/orphan.ts
$ bun run knip
55:10 error Unexpected any @typescript-eslint/no-explicit-any`;
    const sigs = extractFailures(out, "/x");

    expect(sigs.has("knip:unused-file:src/api/note/note.service.test.ts")).toBe(
      true
    );
    expect(sigs.has("knip:unused-file:src/lib/orphan.ts")).toBe(true);
    // The eslint row after the `$` boundary is still parsed normally.
    expect(
      sigs.has("55:10 error Unexpected any @typescript-eslint/no-explicit-any")
    ).toBe(true);
    expect(sigs.size).toBe(3);
  });
});

describe("novelFailures", () => {
  test("returns only failures absent from the baseline", () => {
    const baseline = new Set([
      "(fail) base email test",
      "(fail) base env test",
    ]);
    const current = new Set([
      "(fail) base email test",
      "(fail) base env test",
      "(fail) bookmark service test",
    ]);

    expect(novelFailures(current, baseline)).toEqual([
      "(fail) bookmark service test",
    ]);
  });

  test("returns empty when the feature adds nothing beyond the baseline", () => {
    const baseline = new Set(["(fail) base a", "(fail) base b"]);
    const current = new Set(["(fail) base a"]);

    expect(novelFailures(current, baseline)).toEqual([]);
  });
});
