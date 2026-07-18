import { test, expect } from "bun:test";
import { doCheck } from "../src/loop/tools/check-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type {
  IErrorItem,
  IValidateResult,
} from "../src/validate/validate.types";

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

function result(errors: IErrorItem[]): IValidateResult {
  return { passed: errors.length === 0, errors, output: "" };
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
  // The model-facing struct must NOT leak the internal dedup `key`.
  expect(out).not.toContain('"key"');
});

test("doCheck dedupes by stable key so repeated/dual-format output stays clean", async () => {
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
