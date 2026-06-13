import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILoopEvent } from "../src/loop/loop.types";
import { loadProjectTtsrRules, initTtsrManager } from "../src/loop/run";

/** Write `.tsforge/rules.json` under a fresh temp dir and return the dir. */
async function withProjectRules(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ttsr-"));

  await mkdir(join(dir, ".tsforge"), { recursive: true });
  await writeFile(join(dir, ".tsforge", "rules.json"), content);

  return dir;
}

const CUSTOM_RULE = {
  name: "custom-foo",
  condition: ["FOOBAR"],
  scope: "tool-args",
  guidance: "Do not write FOOBAR.",
  repeatMode: "once",
};

test("loadProjectTtsrRules reads .tsforge/rules.json from cwd", async () => {
  const dir = await withProjectRules(JSON.stringify([CUSTOM_RULE]));

  const rules = await loadProjectTtsrRules(dir);

  expect(rules.length).toBe(1);
  expect(rules[0]?.name).toBe("custom-foo");

  await rm(dir, { recursive: true, force: true });
});

test("loadProjectTtsrRules returns [] when the file is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ttsr-"));

  const rules = await loadProjectTtsrRules(dir);

  expect(rules.length).toBe(0);

  await rm(dir, { recursive: true, force: true });
});

test("loadProjectTtsrRules returns [] on malformed JSON", async () => {
  const dir = await withProjectRules("{ broken json");

  const rules = await loadProjectTtsrRules(dir);

  expect(rules.length).toBe(0);

  await rm(dir, { recursive: true, force: true });
});

test("initTtsrManager merges project rules so a custom rule fires", async () => {
  const dir = await withProjectRules(JSON.stringify([CUSTOM_RULE]));
  const events: ILoopEvent[] = [];

  const manager = await initTtsrManager(dir, (e) => events.push(e), "t");

  expect(manager).not.toBeNull();

  const matched = manager?.checkDelta("prefix FOOBAR suffix", {
    source: "tool-args",
  });

  expect(matched?.name).toBe("custom-foo");
  expect(
    events.some((e) => e.kind === "ttsr" && e.message.includes("1 custom"))
  ).toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("initTtsrManager: built-in rule wins over a same-named project rule", async () => {
  // A project rule named after a built-in must be ignored (addRule dedup),
  // so the built-in's behavior — not the project condition — stays in force.
  const shadow = {
    name: "no-as-any",
    condition: ["PROJECT_ONLY_TOKEN"],
    scope: "tool-args",
    guidance: "shadow",
    repeatMode: "once",
  };
  const dir = await withProjectRules(JSON.stringify([shadow]));

  const manager = await initTtsrManager(dir, () => undefined, "t");

  // If the project rule had won, this token would fire `no-as-any`.
  const matched = manager?.checkDelta("PROJECT_ONLY_TOKEN", {
    source: "tool-args",
  });

  expect(matched).toBeNull();

  await rm(dir, { recursive: true, force: true });
});
