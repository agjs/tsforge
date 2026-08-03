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

    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(target.polluted).toBeUndefined();
  });

  test("does not descend into an inherited property", () => {
    const base = { shared: { hi: true } };
    const target: Record<string, unknown> = Object.create(base);

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
    // reserved: owned by the request builder
    ["model"],
    ["messages"],
    ["temperature"],
    ["tools"],
    ["tool_choice"],
    ["stream"],
    ["stream_options.include_usage"],
    ["repetition_penalty"],
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
  test("an explicit tokenCap frees up the default path for another control", () => {
    // Only the DEFAULT participates when tokenCap is unset; moving the cap
    // elsewhere makes max_tokens available again.
    expect(
      isReasoningProfile({ tokenCap: "output_limit", effort: "max_tokens" })
    ).toBe(true);
  });

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
    [{ budegt: "reasoning.max_tokens" }, "a misspelled key"],
    [{ thnking: { path: "mode" } }, "a misspelled thinking key"],
    [{ thinking: { path: "a" }, extra: 1 }, "an unknown extra key"],
    [{ thinking: { path: "a", onValu: 1 } }, "a typo inside thinking"],
    [
      { tokenCap: "params", thinking: { path: "params.enabled" } },
      "an ancestor/descendant path pair",
    ],
    [{ effort: "a.b", budget: "a.b" }, "two identical paths"],
    [{ tokenCap: "a", effort: "a.b.c" }, "a path nested under another"],
    // The token cap is written even when unset, so its DEFAULT must take part
    // in the overlap check or a reasoning field silently destroys it.
    [{ effort: "max_tokens" }, "effort colliding with the default token cap"],
    [
      { thinking: { path: "max_tokens" } },
      "thinking colliding with the default token cap",
    ],
    [{ budget: "max_tokens.x" }, "a path nested under the default token cap"],
    // A profile must not be able to reach fields the request builder owns.
    [{ tokenCap: "messages" }, "targeting the conversation"],
    [{ thinking: { path: "model" } }, "targeting the model id"],
    [{ effort: "temperature" }, "targeting temperature"],
    [{ budget: "tools.0" }, "nesting under tools"],
    [
      { effort: "stream_options.include_usage" },
      "nesting under stream_options",
    ],
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
