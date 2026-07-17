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

  test("per-app coverage: API JSON `[]` (green) does NOT suppress UI's stylish errors when the UI block is malformed", () => {
    // The gate emits TWO blocks (api, ui). API is green ([]), UI's block is malformed
    // → UI is NOT "covered", so its stylish eslint error must still be captured (a
    // global flag would have lost it — the exact near-green regression the panel flagged).
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

  test("a wrong-shaped JSON array (`[1,2,3]`) does NOT count as coverage — stylish is still scraped", () => {
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
