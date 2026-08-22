import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { linkifyFileLine, osc8Link } from "../src/render/osc8-link";

describe("osc8-link", () => {
  const prev = process.env.TSFORGE_NO_OSC8;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, "TSFORGE_NO_OSC8");
  });

  afterEach(() => {
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, "TSFORGE_NO_OSC8");
    } else {
      process.env.TSFORGE_NO_OSC8 = prev;
    }
  });

  test("osc8Link wraps text with escape sequences", () => {
    const out = osc8Link("src/a.ts:1", "file:///tmp/src/a.ts:1");

    expect(out).toContain("\x1b]8;;");
    expect(out).toContain("src/a.ts:1");
    expect(out.endsWith("\x1b\\")).toBe(true);
  });

  test("linkifyFileLine leaves text plain when disabled", () => {
    process.env.TSFORGE_NO_OSC8 = "1";

    expect(linkifyFileLine("error at src/foo.ts:12", "/repo")).toBe(
      "error at src/foo.ts:12"
    );
  });

  test("linkifyFileLine wraps ts segments when OSC8 enabled", () => {
    const out = linkifyFileLine("see src/foo.ts:12 ok", "/repo");

    if (process.stdout.isTTY) {
      expect(out).toContain("\x1b]8;;");
      expect(out).toContain("src/foo.ts:12");
    } else {
      expect(out).toBe("see src/foo.ts:12 ok");
    }
  });
});
