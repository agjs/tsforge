import { test, expect } from "bun:test";
import { doCheck } from "../src/loop/tools/check-tool";
import type {
  IToolContext,
  ICheckOutcome,
} from "../src/loop/tools/tool-context";
import type { IErrorItem } from "../src/validate/validate.types";

/** A minimal structural IToolContext — only the fields doCheck reads, plus an
 *  injectable runCheck. Built structurally (no cast) so the test tracks the real
 *  interface: a required field going missing breaks compilation. */
function ctxWith(runCheck?: IToolContext["runCheck"]): IToolContext {
  return {
    cwd: "/workspace",
    files: [],
    report: () => undefined,
    task: "check-test",
    ...(runCheck === undefined ? {} : { runCheck }),
  };
}

function err(part: Partial<IErrorItem> & { key: string }): IErrorItem {
  return { message: "boom", ...part };
}

function result(
  errors: IErrorItem[],
  extra: Partial<ICheckOutcome> = {}
): ICheckOutcome {
  return {
    passed: errors.length === 0,
    errors,
    output: "",
    autoFixed: [],
    command: "eslint .",
    packs: ["generic-ts", "code-flow"],
    ...extra,
  };
}

test("doCheck reports it isn't available when no runCheck is wired", async () => {
  const out = await doCheck({}, ctxWith());

  expect(out).toContain("not available");
  // Must NOT masquerade as a passing gate — a missing seam is not "green".
  expect(out).not.toContain('"passed":true');
});

test("doCheck returns passed:true with an empty error list on a green gate", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () => result([]))
  );

  expect(JSON.parse(out)).toEqual({ passed: true, errors: [] });
});

test("doCheck returns the whole structured error set on a red gate", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([
        err({
          key: "a",
          file: "src/x.ts",
          line: 3,
          rule: "no-unused-vars",
          message: "'y' is unused",
        }),
        err({ key: "b", file: "src/y.ts", message: "type error" }),
      ])
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.passed).toBe(false);
  expect(parsed.errorCount).toBe(2);
  expect(parsed.errors).toEqual([
    {
      file: "src/x.ts",
      line: 3,
      rule: "no-unused-vars",
      message: "'y' is unused",
    },
    { file: "src/y.ts", message: "type error" },
  ]);
  expect(parsed.command).toBe("eslint .");
  expect(parsed.packs).toEqual(["generic-ts", "code-flow"]);
  // The model-facing struct must NOT leak the internal dedup `key`.
  expect(out).not.toContain('"key"');
});

test("doCheck drops only fully-identical diagnostics (dual-format re-emission)", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([
        err({ key: "dup", file: "src/x.ts", line: 1, message: "same" }),
        err({ key: "dup", file: "src/x.ts", line: 1, message: "same" }),
        err({ key: "other", file: "src/z.ts", line: 9, message: "diff" }),
      ])
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.errorCount).toBe(2);
  expect(parsed.errors).toHaveLength(2);
});

test("doCheck keeps two DISTINCT diagnostics that share a coarse key but differ in message", async () => {
  // Meta-rule keys are only `file:ruleId` (no line), so two distinct violations of one
  // rule in one file share a key. Deduping on key alone would collapse them and
  // under-report errorCount — the whole-error-set contract must not silently drop one.
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([
        err({
          key: "src/a.ts:no-eslint-disable-comments",
          file: "src/a.ts",
          rule: "no-eslint-disable-comments",
          message: "disable on line 3",
        }),
        err({
          key: "src/a.ts:no-eslint-disable-comments",
          file: "src/a.ts",
          rule: "no-eslint-disable-comments",
          message: "disable on line 9",
        }),
      ])
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.errorCount).toBe(2);
  expect(parsed.errors).toHaveLength(2);
});

test("doCheck caps the list at 200 and records how many were omitted", async () => {
  const many = Array.from({ length: 250 }, (_v, i) =>
    err({ key: `k${String(i)}`, file: `src/f${String(i)}.ts`, message: "e" })
  );

  const out = await doCheck(
    {},
    ctxWith(async () => result(many))
  );
  const parsed = JSON.parse(out);

  expect(parsed.errorCount).toBe(250);
  expect(parsed.errors).toHaveLength(200);
  expect(parsed.omitted).toBe(50);
});

test("doCheck surfaces autoFixed files so the model re-reads after a mid-turn rewrite", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () => result([], { autoFixed: ["src/a.ts", "src/b.ts"] }))
  );

  expect(JSON.parse(out)).toEqual({
    passed: true,
    errors: [],
    autoFixed: ["src/a.ts", "src/b.ts"],
  });
});

test("doCheck surfaces raw output when the gate failed but parsed NO structured errors", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([], { passed: false, output: "Command crashed: ENOSPC\nstack..." })
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.passed).toBe(false);
  expect(parsed.errorCount).toBe(0);
  // Without this the model would be blind to why the gate failed.
  expect(parsed.output).toContain("ENOSPC");
});

test("doCheck surfaces a SHORT output tail when structured errors are present (catches a hidden crash, disclosed)", async () => {
  // The errors are the distilled signal; output is capped hard (600) so a trailing
  // unparsed crash is still visible without re-dumping the whole gate log.
  const head = "lint noise ".repeat(200);
  const tail = "SEGFAULT after the lint errors";
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([err({ key: "a", file: "src/x.ts", message: "e" })], {
        passed: false,
        output: head + tail,
      })
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.errorCount).toBe(1);
  // The trailing crash survives; the head is dropped and the cut disclosed.
  expect(parsed.output).toContain("SEGFAULT after the lint errors");
  expect(parsed.output.length).toBe(600);
  expect(parsed.outputTruncated).toBe(true);
});

test("doCheck discloses the output cap (tail kept, omitted count) — no silent truncation", async () => {
  // Failure detail is usually LAST, so the tail must survive and the cut be disclosed.
  const head = "x".repeat(5000);
  const tail = "FATAL: the real error is here";
  const out = await doCheck(
    {},
    ctxWith(async () => result([], { passed: false, output: head + tail }))
  );

  const parsed = JSON.parse(out);

  expect(parsed.outputTruncated).toBe(true);
  expect(parsed.outputOmittedChars).toBe(head.length + tail.length - 4000);
  expect(parsed.output).toContain("FATAL: the real error is here");
  expect(parsed.output.length).toBe(4000);
});

test("doCheck does NOT mark truncation when output fits under the cap", async () => {
  const out = await doCheck(
    {},
    ctxWith(async () =>
      result([], { passed: false, output: "short crash log" })
    )
  );

  const parsed = JSON.parse(out);

  expect(parsed.output).toBe("short crash log");
  expect(parsed.outputTruncated).toBeUndefined();
  expect(parsed.outputOmittedChars).toBeUndefined();
});
