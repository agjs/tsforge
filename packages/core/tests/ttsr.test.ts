import { test, expect } from "bun:test";
import { TtsrManager, parseProjectRules } from "../src/loop/ttsr";
import type { ITtsrRule } from "../src/loop/ttsr";
import { DEFAULT_TTSR_RULES } from "../src/loop/ttsr-defaults";

function withDefaults(): TtsrManager {
  const m = new TtsrManager();

  for (const rule of DEFAULT_TTSR_RULES) {
    m.addRule(rule);
  }

  return m;
}

test("built-in no-as-cast fires on an `as` cast, in ANY file (no globs)", () => {
  // A monorepo path (apps/api/…) — the old `src/**` globs never matched these.
  const hit = withDefaults().checkDelta("  return row as IBookmark;\n", {
    source: "tool-args",
    currentFile: "apps/api/src/api/bookmark/x.ts",
  });

  expect(hit?.name).toBe("no-as-cast");
});

test("built-in no-as-cast does NOT fire on `as const`", () => {
  const hit = withDefaults().checkDelta("const KEYS = ['a', 'b'] as const;\n", {
    source: "tool-args",
    currentFile: "apps/ui/src/x.ts",
  });

  expect(hit).toBeNull();
});

test("built-in no-eslint-disable fires on an eslint-disable comment", () => {
  const hit = withDefaults().checkDelta(
    "// eslint-disable-next-line @typescript-eslint/no-explicit-any\n",
    { source: "tool-args", currentFile: "apps/api/src/x.ts" }
  );

  expect(hit?.name).toBe("no-eslint-disable");
});

test("adds and matches a single regex rule", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/\bas\s+any\b/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  const added = manager.addRule(rule);

  expect(added).toBe(true);

  const matched = manager.checkDelta("const x = y as any;", {
    source: "tool-args",
  });

  expect(matched).not.toBeNull();
  expect(matched?.name).toBe("test-rule");
});

test("does not match on wrong scope", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/\bas\s+any\b/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  const matched = manager.checkDelta("const x = y as any;", {
    source: "content",
  });

  expect(matched).toBeNull();
});

test("matches patterns spanning chunk boundaries", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/as\s+any/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  manager.checkDelta("const x = y ", { source: "tool-args" });

  const matched = manager.checkDelta("as any;", { source: "tool-args" });

  expect(matched).not.toBeNull();
});

test("respects once repeatMode: fires once, then never", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/bad/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  const first = manager.checkDelta("bad", { source: "tool-args" });

  expect(first).not.toBeNull();

  manager.markFired("test-rule", 1);
  manager.resetBuffer();

  const second = manager.checkDelta("bad", { source: "tool-args" });

  expect(second).toBeNull();
});

test("respects cooldown repeatMode: refires after gap", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/bad/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "cooldown",
    repeatGap: 2,
  };

  manager.addRule(rule);

  // Turn 1: first match
  const first = manager.checkDelta("bad", { source: "tool-args" });

  expect(first).not.toBeNull();

  manager.markFired("test-rule", 0); // fired at turn 0
  manager.resetBuffer();

  // Turn 1 ends, increment to 1
  manager.incrementTurnCount(); // messageCount = 1
  const second = manager.checkDelta("bad", { source: "tool-args" });

  expect(second).toBeNull(); // gap = 1 - 0 = 1, need 2: no match

  manager.resetBuffer();

  // Turn 2 ends, increment to 2
  manager.incrementTurnCount(); // messageCount = 2
  const third = manager.checkDelta("bad", { source: "tool-args" });

  expect(third).not.toBeNull(); // gap = 2 - 0 = 2, meets requirement: match
});

test("matches OR'd conditions", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/as\s+any/, /@ts-ignore/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  const match1 = manager.checkDelta("const x = y as any;", {
    source: "tool-args",
  });

  expect(match1).not.toBeNull();

  manager.resetBuffer();

  const match2 = manager.checkDelta("// @ts-ignore\nconst x: any = y;", {
    source: "tool-args",
  });

  expect(match2).not.toBeNull();
});

test("rejects invalid regex", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: ["[invalid(regex"],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  const added = manager.addRule(rule);

  expect(added).toBe(false);
});

test("rejects duplicate rule names", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/bad/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  const first = manager.addRule(rule);
  const second = manager.addRule(rule);

  expect(first).toBe(true);
  expect(second).toBe(false);
});

test("tracks both scopes independently", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/bad/],
    scope: "both",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  const contentMatch = manager.checkDelta("bad", { source: "content" });

  expect(contentMatch).not.toBeNull();

  manager.resetBuffer();

  const toolMatch = manager.checkDelta("bad", { source: "tool-args" });

  expect(toolMatch).not.toBeNull();
});

test("resets buffers on resetBuffer()", () => {
  const manager = new TtsrManager();
  const rule: ITtsrRule = {
    name: "test-rule",
    condition: [/bad/],
    scope: "tool-args",
    guidance: "Fix this.",
    repeatMode: "once",
  };

  manager.addRule(rule);

  const first = manager.checkDelta("ba", { source: "tool-args" });

  expect(first).toBeNull();

  manager.resetBuffer();

  const second = manager.checkDelta("d", { source: "tool-args" });

  expect(second).toBeNull();
});

test("parseProjectRules: validates JSON array", () => {
  const json = JSON.stringify([
    {
      name: "rule1",
      condition: ["test"],
      scope: "tool-args",
      guidance: "Fix it",
      repeatMode: "once",
    },
    {
      name: "rule2",
      condition: ["bad"],
      scope: "content",
      guidance: "Bad prose",
      repeatMode: "cooldown",
      repeatGap: 3,
    },
  ]);

  const rules = parseProjectRules(json);

  expect(rules.length).toBe(2);
  expect(rules[0]?.name).toBe("rule1");
  expect(rules[1]?.name).toBe("rule2");
  expect(rules[1]?.repeatGap).toBe(3);
});

test("parseProjectRules: skips invalid entries", () => {
  const json = JSON.stringify([
    {
      name: "rule1",
      condition: ["test"],
      scope: "tool-args",
      guidance: "Fix it",
      repeatMode: "once",
    },
    {
      name: "rule2",
      // missing condition
      scope: "tool-args",
      guidance: "Bad",
      repeatMode: "once",
    },
    {
      name: "rule3",
      condition: ["test"],
      scope: "tool-args",
      guidance: "Good",
      repeatMode: "once",
    },
  ]);

  const rules = parseProjectRules(json);

  expect(rules.length).toBe(2);
  expect(rules.map((r) => r.name)).toEqual(["rule1", "rule3"]);
});

test("parseProjectRules: handles non-array JSON", () => {
  const rules = parseProjectRules('{ "not": "an array" }');

  expect(rules.length).toBe(0);
});

test("parseProjectRules: handles invalid JSON", () => {
  const rules = parseProjectRules("{ broken json");

  expect(rules.length).toBe(0);
});
