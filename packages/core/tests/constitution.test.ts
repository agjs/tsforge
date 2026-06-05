import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeConstitution,
  bringConstitution,
} from "../src/constitution/baseline";

test("brings a strict gate floor into a bare repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-const-"));

  try {
    const r = await bringConstitution(dir);

    expect(r.written).toContain("tsconfig.json");
    expect(r.written).toContain("eslint.config.js");
    expect(r.written).toContain(".prettierrc.json");
    expect(r.verify).toContain("tsc");
    expect(r.verify).toContain("eslint");
    expect(r.verify).toContain("prettier");
    expect(r.verify).toContain("bun test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Non-destructive: a repo's own configs are authority; we only fill a floor
// where there is none.
test("is non-destructive — keeps the repo's own configs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-const-"));

  try {
    await Bun.write(join(dir, "tsconfig.json"), '{ "compilerOptions": {} }');
    await Bun.write(join(dir, "eslint.config.js"), "export default [];");

    const before = await Bun.file(join(dir, "tsconfig.json")).text();
    const r = await bringConstitution(dir);

    expect(r.skipped).toContain("tsconfig.json");
    expect(r.skipped).toContain("eslint.config.js");
    expect(r.written).toContain(".prettierrc.json");
    // their tsconfig is untouched
    expect(await Bun.file(join(dir, "tsconfig.json")).text()).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The floor must have teeth — prove the brought tsconfig is genuinely strict.
test("the brought tsconfig is genuinely strict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-const-"));

  try {
    await bringConstitution(dir);

    const cfg = JSON.parse(await Bun.file(join(dir, "tsconfig.json")).text());

    expect(cfg.compilerOptions.strict).toBe(true);
    expect(cfg.compilerOptions.noUncheckedIndexedAccess).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// And the eslint floor carries the house rules an agent must obey.
test("the brought eslint config carries the house rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-const-"));

  try {
    await bringConstitution(dir);

    const cfg = await Bun.file(join(dir, "eslint.config.js")).text();

    expect(cfg).toContain("no-non-null-assertion");
    expect(cfg).toContain("no-explicit-any");
    expect(cfg).toContain("naming-convention");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports what's present without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-const-"));

  try {
    await Bun.write(join(dir, ".prettierrc.json"), "{}");

    const state = await analyzeConstitution(dir);

    expect(state.prettier).toBe(true);
    expect(state.tsconfig).toBe(false);
    expect(state.eslint).toBe(false);
    // analyze must not create anything
    expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
