import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFeedback } from "../src/loop/feedback";
import {
  buildMetaBaseline,
  subtractMetaBaseline,
} from "../src/meta-rules/baseline";
import type { IMetaRuleViolation } from "../src/meta-rules";
import type { ITask } from "../src/spec";
import type { ErrorSet } from "../src/validate";

const TASK: ITask = {
  id: "1",
  files: ["money.ts"],
  accept: "tsc -p tsconfig.json",
  intent: "",
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-fb-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("gateFeedback shows location + the offending source line (no hand-counting)", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "money.ts"),
      [
        "export function allocate(total: number, ratios: number[]): number[] {",
        "  for (let i = 0; i < ratios.length; i += 1) {",
        "    const share = (total * ratios[i]) / 3;",
        "  }",
        "  return [];",
        "}",
      ].join("\n")
    );

    const errors: ErrorSet = [
      {
        key: "money.ts:3:TS2532",
        file: "money.ts",
        line: 3,
        rule: "TS2532",
        message: "Object is possibly 'undefined'.",
      },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("money.ts:3");
    expect(fb).toContain("[TS2532]");
    // The actual code at line 3 is inlined — the model needn't read+count.
    expect(fb).toContain("const share = (total * ratios[i]) / 3;");
  });
});

test("gateFeedback degrades gracefully when an error has no location", async () => {
  await withDir(async (dir) => {
    const errors: ErrorSet = [
      { key: "nonzero", message: "command exited non-zero" },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("command exited non-zero");
  });
});

test("gateFeedback does not claim a populated glob scope is a missing literal file", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "feature.ts"), "export const feature = true;\n");
    const task: ITask = {
      ...TASK,
      files: ["**/*.ts"],
    };
    const errors: ErrorSet = [
      { key: "nonzero", message: "command exited non-zero" },
    ];

    const feedback = await gateFeedback(errors, task, dir);

    expect(feedback).not.toContain("do NOT exist yet");
    expect(feedback).not.toContain("**/*.ts");
  });
});

test("gateFeedback caps repeats of one rule so other rules still surface", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    // 25× the same rule would previously wall the whole 20-line budget and
    // the single OTHER error (a different rule, emitted last) was truncated.
    const noisy: ErrorSet = Array.from({ length: 25 }, (_, i) => ({
      key: `money.ts:${i + 1}:no-explicit-any`,
      file: "money.ts",
      line: 1,
      rule: "no-explicit-any",
      message: "Unexpected any.",
    }));
    const errors: ErrorSet = [
      ...noisy,
      {
        key: "money.ts:1:TS2304",
        file: "money.ts",
        line: 1,
        rule: "TS2304",
        message: "Cannot find name 'foo'.",
      },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    // The distinct rule must be rendered in full, not truncated away.
    expect(fb).toContain("[TS2304]");
    expect(fb).toContain("Cannot find name 'foo'.");
    // The noisy rule is summarized, not repeated 25 times.
    expect(fb).toContain("22 more [no-explicit-any]");
    expect((fb.match(/Unexpected any\./g) ?? []).length).toBeLessThanOrEqual(3);
  });
});

test("gateFeedback summarizes overflow by rule with affected files", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    const errors: ErrorSet = Array.from({ length: 30 }, (_, i) => ({
      key: `money.ts:${i + 1}:TS2532`,
      file: "money.ts",
      line: 1,
      rule: "TS2532",
      message: "Object is possibly 'undefined'.",
    }));

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("same rules, same fixes apply");
    expect(fb).toContain("27 more [TS2532] in money.ts");
  });
});

test("gateFeedback renders out-of-scope errors with content + 'cannot edit' framing (not a bare count)", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");
    await Bun.write(
      join(dir, "locked.test.ts"),
      Array.from({ length: 8 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n"
    );

    // The ONLY blocking error is in a file outside the task's editable scope
    // (task.files = ["money.ts"]). The model must SEE it, not a count.
    const errors: ErrorSet = [
      {
        key: "locked.test.ts:7:TS2345",
        file: "locked.test.ts",
        line: 7,
        rule: "TS2345",
        message:
          "Argument of type 'string' is not assignable to parameter of type 'number'.",
      },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    // Real path + message are shown, not hidden behind a count.
    expect(fb).toContain("locked.test.ts");
    expect(fb).toContain("not assignable");
    // Correct framing: you cannot edit these; fix the producer; don't edit them.
    expect(fb).toContain("cannot edit");
    // The old false note is gone.
    expect(fb).not.toContain("not yours to fix");
    expect(fb).not.toContain("resolve once your files are correct");
  });
});

test("gateFeedback shares ONE render budget across editable + locked errors (no 40-wall)", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");
    await Bun.write(join(dir, "locked.ts"), "export const y = 2;\n");

    // Distinct rule per error so the per-rule cap doesn't confound the line cap.
    const own: ErrorSet = Array.from({ length: 20 }, (_, i) => ({
      key: `money.ts:${i + 1}:own-${i}`,
      file: "money.ts",
      line: 1,
      rule: `own-rule-${i}`,
      message: `own error ${i}`,
    }));
    const locked: ErrorSet = Array.from({ length: 20 }, (_, i) => ({
      key: `locked.ts:${i + 1}:locked-${i}`,
      file: "locked.ts",
      line: 1,
      rule: `locked-rule-${i}`,
      message: `locked error ${i}`,
    }));

    const fb = await gateFeedback([...own, ...locked], TASK, dir);

    const shownOwn = (fb.match(/own error \d+/g) ?? []).length;
    const shownLocked = (fb.match(/locked error \d+/g) ?? []).length;

    // FEEDBACK_MAX_LINES is 20 — the combined budget, NOT 40 (a wall per side).
    expect(shownOwn + shownLocked).toBeLessThanOrEqual(20);
    // The remainder is summarized, not dropped silently.
    expect(fb).toContain("more");
  });
});

test("gateFeedback R3 focus on an out-of-scope error shows only that one (narrowing preserved)", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    const errors: ErrorSet = [
      {
        key: "a",
        file: "locked.ts",
        line: 1,
        rule: "R1",
        message: "focused locked error",
      },
      {
        key: "b",
        file: "locked.ts",
        line: 2,
        rule: "R2",
        message: "other locked error",
      },
    ];
    const focusKey = ["locked.ts", 1, "R1"].join(":");

    const fb = await gateFeedback(errors, TASK, dir, [], focusKey);

    expect(fb).toContain("focused locked error");
    expect(fb).not.toContain("other locked error");
  });
});

test("REGRESSION (bshands6 park): 0 editable errors + locked-consumer errors + 2 pre-existing meta WARNs → shows the locked errors, hides the baseline WARNs", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");
    // Locked consumers of the feature's types (outside TASK.files = ["money.ts"]).
    await Bun.write(
      join(dir, "queries.test.ts"),
      Array.from({ length: 8 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n"
    );
    await Bun.write(
      join(dir, "Page.stories.tsx"),
      Array.from({ length: 8 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n"
    );

    // The gate is red ONLY in locked consumer files — none editable by the model.
    const lockedErrors: ErrorSet = [
      {
        key: "queries.test.ts:5:TS2554",
        file: "queries.test.ts",
        line: 5,
        rule: "TS2554",
        message: "Expected 2 arguments, but got 1.",
      },
      {
        key: "Page.stories.tsx:3:TS2322",
        file: "Page.stories.tsx",
        line: 3,
        rule: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ];

    // The two pre-existing scaffold WARNs that misled the model at bshands6.
    const scaffoldWarns: IMetaRuleViolation[] = [
      {
        file: ".github/workflows/apps-ui-release.yml",
        ruleId: "l-least-privilege",
        severity: "warn",
        message: "workflow grants contents: write at the workflow level",
      },
      {
        file: "package.json",
        ruleId: "lockfile-required",
        severity: "warn",
        message: "no lockfile committed",
      },
    ];

    // Pristine baseline captured them; this cycle re-reports the SAME two → subtracted.
    const baseline = buildMetaBaseline(scaffoldWarns);
    const metaThisCycle = subtractMetaBaseline(scaffoldWarns, baseline);

    expect(metaThisCycle).toEqual([]); // the WARNs are baseline debt, not new

    const fb = await gateFeedback(lockedErrors, TASK, dir, metaThisCycle);

    // The model SEES the real locked-consumer errors (paths + messages), not a count.
    expect(fb).toContain("queries.test.ts");
    expect(fb).toContain("Expected 2 arguments");
    expect(fb).toContain("Page.stories.tsx");
    expect(fb).toContain("cannot edit");
    // The baseline WARNs are gone — no more fixating on workflow perms / lockfile.
    expect(fb).not.toContain("l-least-privilege");
    expect(fb).not.toContain("lockfile-required");
    expect(fb).not.toContain("Project structure");
    // And the old false reassurance is gone.
    expect(fb).not.toContain("not yours to fix");
  });
});

test("gateFeedback labels rule-less overflow as 'unclassified errors', not [other]", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    // 22 errors with NO rule id (generic/oracle output): 20 render, 2 overflow
    // into the summary and must read as prose, not a fictitious rule `[other]`.
    const errors: ErrorSet = Array.from({ length: 22 }, (_, i) => ({
      key: `money.ts:${i + 1}:generic`,
      file: "money.ts",
      line: 1,
      message: "command exited non-zero",
    }));

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("more unclassified errors");
    expect(fb).not.toContain("[other]");
  });
});
