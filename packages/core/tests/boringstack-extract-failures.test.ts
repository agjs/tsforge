import { test, expect, describe } from "bun:test";
import {
  extractFailures,
  novelFailures,
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
        "(fail) validateEnv > rejects production EMAIL_FROM on a placeholder domain"
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
        "/apps/api/src/api/bookmark/bookmark.service.ts(38,3): error TS2532: Object is possibly 'undefined'."
      )
    ).toBe(true);
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
