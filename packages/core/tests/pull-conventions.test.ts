import { test, expect, describe } from "bun:test";
import { doPullConventions } from "../src/loop/tools/pull-conventions";
import { boringstackConventionProvider } from "../src/loop/conventions";

// The tool reads the convention library from the injected provider (ctx.conventions), so a real
// call supplies the BoringStack provider — the same one the adapter injects at runtime.
const ctx = { conventions: boringstackConventionProvider };

describe("pull_conventions tool", () => {
  test("returns the guide for a valid topic", () => {
    expect(doPullConventions({ topic: "no-casts" }, ctx)).toContain(
      "TYPE GUARD"
    );
    expect(doPullConventions({ topic: "component-anatomy" }, ctx)).toContain(
      "src/features/"
    );
    expect(doPullConventions({ topic: "data-fetching" }, ctx)).toContain(
      "@/lib/api/client"
    );
  });

  test("an unknown/empty topic lists the valid ones (never a bare failure)", () => {
    const r = doPullConventions({ topic: "styling" }, ctx);

    expect(r).toContain("unknown topic");
    expect(r).toContain("component-anatomy");
    expect(r).toContain("no-casts");
  });

  test("no provider ⇒ a clear 'not configured' message, never a crash", () => {
    const r = doPullConventions(
      { topic: "no-casts" },
      { conventions: undefined }
    );

    expect(r).toContain("no convention library");
  });
});
