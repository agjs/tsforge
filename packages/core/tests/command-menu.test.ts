import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterCommands, clampIndex } from "../src/render/command-menu";
import { COMMANDS, COMMAND_VERBS, formatHelp } from "../src/cli/commands";

test("filterCommands: empty query returns all; leading slash is ignored", () => {
  expect(filterCommands(COMMANDS, "")).toHaveLength(COMMANDS.length);
  expect(filterCommands(COMMANDS, "/ga").map((c) => c.name)).toEqual(["/gate"]);
});

test("filterCommands: substring match, case-insensitive", () => {
  const names = filterCommands(COMMANDS, "ME").map((c) => c.name);

  expect(names).toContain("/memory");
  expect(names).toContain("/metrics");
  expect(names).not.toContain("/model"); // "model" has no "me"
});

test("clampIndex wraps and tolerates an empty list", () => {
  expect(clampIndex(-1, 3)).toBe(2);
  expect(clampIndex(3, 3)).toBe(0);
  expect(clampIndex(1, 3)).toBe(1);
  expect(clampIndex(0, 0)).toBe(0);
});

test("registry ↔ cli.ts switch parity (no command without an executor, or vice versa)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "src", "cli.ts"),
    "utf8"
  );
  const cases = new Set(
    [...src.matchAll(/case "([a-z]+)":/gu)].map((m) => m[1])
  );

  expect(cases).toEqual(new Set(COMMAND_VERBS));
});

test("formatHelp lists every registry command", () => {
  const help = formatHelp();

  for (const c of COMMANDS) {
    expect(help).toContain(c.name);
  }
});
