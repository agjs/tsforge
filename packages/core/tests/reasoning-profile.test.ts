import { test, expect, describe } from "bun:test";
import {
  REASONING_PRESETS,
  isReasoningProfile,
  isReasoningStyle,
  isSafePath,
  setPath,
} from "../src/inference/reasoning-profile";

describe("setPath", () => {
  test("writes a top-level key", () => {
    expect(setPath({}, "a", 1)).toEqual({ a: 1 });
  });

  test("creates intermediate objects for a dot path", () => {
    expect(setPath({}, "a.b.c", 1)).toEqual({ a: { b: { c: 1 } } });
  });

  test("merges into an existing object rather than replacing it", () => {
    const t: Record<string, unknown> = { a: { keep: true } };

    setPath(t, "a.added", 1);

    expect(t).toEqual({ a: { keep: true, added: 1 } });
  });

  test("overwrites a non-object sitting at an intermediate segment", () => {
    // Bailing out instead would silently drop the field the caller asked for.
    expect(setPath({ a: 5 }, "a.b", 1)).toEqual({ a: { b: 1 } });
    expect(setPath({ a: [1, 2] }, "a.b", 1)).toEqual({ a: { b: 1 } });
    expect(setPath({ a: null }, "a.b", 1)).toEqual({ a: { b: 1 } });
  });

  test.each([[""], ["."], ["a."], [".a"], ["a..b"]])(
    "ignores the malformed path %p instead of throwing",
    (path) => {
      expect(setPath({ untouched: true }, path, 1)).toEqual({
        untouched: true,
      });
    }
  );

  test("refuses to walk into the prototype chain", () => {
    // models.json is user-editable, so a path must not be able to reach
    // Object.prototype and pollute every object in the process.
    const target: Record<string, unknown> = {};

    setPath(target, "__proto__.polluted", "yes");
    setPath(target, "constructor.prototype.polluted", "yes");
    setPath(target, "a.__proto__.polluted", "yes");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(target.polluted).toBeUndefined();
  });

  test("does not descend into an inherited property", () => {
    const base = { shared: { hi: true } };
    const target = Object.create(base) as Record<string, unknown>;

    setPath(target, "shared.mine", 1);

    expect(Object.hasOwn(target, "shared")).toBe(true);
    expect(base.shared).toEqual({ hi: true });
  });
});

describe("isSafePath", () => {
  test.each([["a"], ["a.b"], ["chat_template_kwargs.thinking"]])(
    "accepts %p",
    (p) => expect(isSafePath(p)).toBe(true)
  );

  test.each([
    [""],
    ["."],
    ["a."],
    ["a..b"],
    ["__proto__"],
    ["a.__proto__.b"],
    ["constructor"],
    ["prototype"],
  ])("rejects %p", (p) => expect(isSafePath(p)).toBe(false));
});

describe("isReasoningStyle", () => {
  test("accepts every preset name", () => {
    for (const name of Object.keys(REASONING_PRESETS)) {
      expect(isReasoningStyle(name)).toBe(true);
    }
  });

  test.each([["qwne"], [""], [null], [undefined], [{}], [42]])(
    "rejects %p",
    (v) => expect(isReasoningStyle(v)).toBe(false)
  );

  test("does not accept inherited Object keys as preset names", () => {
    expect(isReasoningStyle("toString")).toBe(false);
    expect(isReasoningStyle("constructor")).toBe(false);
  });
});

describe("isReasoningProfile", () => {
  test("accepts an empty object and a full one", () => {
    expect(isReasoningProfile({})).toBe(true);
    expect(
      isReasoningProfile({
        thinking: { path: "a.b", onValue: 1, offValue: 0 },
        effort: "c",
        budget: "d",
        tokenCap: "e",
        omitTemperature: true,
        omitToolChoice: false,
        replayReasoning: false,
        latchThinking: true,
      })
    ).toBe(true);
  });

  test.each([
    [null, "null"],
    [undefined, "undefined"],
    ["deepseek", "a string"],
    [[], "an array"],
    [{ thinking: true }, "thinking as a boolean"],
    [{ thinking: {} }, "thinking without a path"],
    [{ thinking: { path: 5 } }, "a non-string path"],
    [{ thinking: { path: "__proto__.x" } }, "an unsafe thinking path"],
    [{ effort: 5 }, "a non-string effort"],
    [{ budget: "a..b" }, "a malformed budget path"],
    [{ tokenCap: "constructor.x" }, "an unsafe tokenCap path"],
    [{ latchThinking: "yes" }, "a non-boolean flag"],
  ])("rejects %p (%s)", (value) => {
    expect(isReasoningProfile(value)).toBe(false);
  });
});

describe("REASONING_PRESETS", () => {
  test("every preset is a valid profile", () => {
    for (const [name, p] of Object.entries(REASONING_PRESETS)) {
      expect({ name, valid: isReasoningProfile(p) }).toEqual({
        name,
        valid: true,
      });
    }
  });

  test("only the cloud preset carries the two protocol quirks", () => {
    for (const [name, p] of Object.entries(REASONING_PRESETS)) {
      const quirky = p.replayReasoning === true || p.latchThinking === true;

      expect({ name, quirky }).toEqual({ name, quirky: name === "deepseek" });
    }
  });
});
