import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/loop/prompt";
import {
  buildMetaRuleContext,
  runMetaRules,
  META_RULES,
} from "../src/meta-rules";

afterEach(() => {
  delete process.env.TSFORGE_TDD;
});

const SERVICE = "src/account.service.ts";

test("TEST-FIRST guidance is on by default, off only when TSFORGE_TDD=0", () => {
  delete process.env.TSFORGE_TDD;
  expect(buildSystemPrompt(false, undefined)).toContain("TEST-FIRST");

  process.env.TSFORGE_TDD = "0";
  expect(buildSystemPrompt(false, undefined)).not.toContain("TEST-FIRST");
});

function logicProjectWithoutTest(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-tdd-"));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, SERVICE),
    "export const balance = (n: number): number => n;\n"
  );

  return dir;
}

function siblingViolations(dir: string, changed: string[]) {
  return runMetaRules(
    META_RULES,
    buildMetaRuleContext(dir, [], changed)
  ).filter((x) => x.ruleId === "test-sibling-required");
}

test("errors by default on a CHANGED logic file with no test", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  try {
    const v = siblingViolations(dir, [SERVICE]);

    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBe("error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downgrades to a warn when TSFORGE_TDD=0", () => {
  process.env.TSFORGE_TDD = "0";
  const dir = logicProjectWithoutTest();

  try {
    const v = siblingViolations(dir, [SERVICE]);

    expect(v[0]?.severity).toBe("warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores logic files the agent did NOT change (scoped to the diff)", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  try {
    // empty changed set → nothing is enforced (e.g. non-git, or untouched)
    expect(siblingViolations(dir, [])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a co-located *.test.ts satisfies the requirement", () => {
  delete process.env.TSFORGE_TDD;
  const dir = logicProjectWithoutTest();

  writeFileSync(
    join(dir, "src", "account.service.test.ts"),
    'import { test } from "bun:test";\ntest("x", () => {});\n'
  );

  try {
    expect(siblingViolations(dir, [SERVICE])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a *.setup.ts scene composition/wiring file is exempt, even with no test", () => {
  delete process.env.TSFORGE_TDD;
  const dir = mkdtempSync(join(tmpdir(), "tsforge-tdd-"));

  mkdirSync(join(dir, "src/runtime/phaser/scenes/WorldScene"), {
    recursive: true,
  });

  const setupFile = "src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts";

  writeFileSync(
    join(dir, setupFile),
    "export function setupWorldScene(): void {}\n"
  );

  try {
    expect(siblingViolations(dir, [setupFile])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- BoringStack monorepo: knip only treats tests/** as test entries ---
const BS_SERVICE = "apps/api/src/api/note/note.service.ts";
const BS_MIRRORED = "apps/api/tests/api/note/note.service.test.ts";

function boringstackApiProject(withMirroredTest: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-bs-"));

  mkdirSync(join(dir, "apps/api/src/api/note"), { recursive: true });
  writeFileSync(
    join(dir, BS_SERVICE),
    "export const createNote = (t: string): string => t;\n"
  );
  // knip config whose ONLY test entry is tests/**/*.test.ts (BoringStack API).
  writeFileSync(
    join(dir, "apps/api/knip.json"),
    JSON.stringify({
      entry: ["scripts/**/*.ts", "src/**/index.ts", "tests/**/*.test.ts"],
      project: ["src/**/*.ts!"],
    })
  );

  if (withMirroredTest) {
    mkdirSync(join(dir, "apps/api/tests/api/note"), { recursive: true });
    writeFileSync(
      join(dir, BS_MIRRORED),
      'import { test } from "bun:test";\ntest("x", () => {});\n'
    );
  }

  return dir;
}

test("BoringStack: the MIRRORED apps/api/tests test satisfies the rule (detection, not just message)", () => {
  delete process.env.TSFORGE_TDD;
  const dir = boringstackApiProject(true);

  try {
    // The acceptance test the review demanded: with only the mirrored test present,
    // changing the service must produce ZERO test-sibling violations.
    expect(siblingViolations(dir, [BS_SERVICE])).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BoringStack: with no test, the message steers to the MIRRORED path, never co-located", () => {
  delete process.env.TSFORGE_TDD;
  const dir = boringstackApiProject(false);

  try {
    const v = siblingViolations(dir, [BS_SERVICE]);

    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain(BS_MIRRORED);
    // The trap was suggesting a co-located src test knip then rejects forever.
    expect(v[0]?.message).not.toContain("(co-located)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
