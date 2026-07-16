import { test, expect, describe } from "bun:test";
import { doPullConventions } from "../src/loop/tools/pull-conventions";

describe("pull_conventions tool", () => {
  test("returns the guide for a valid topic", () => {
    expect(doPullConventions({ topic: "no-casts" })).toContain("TYPE GUARD");
    expect(doPullConventions({ topic: "component-anatomy" })).toContain(
      "src/features/"
    );
    expect(doPullConventions({ topic: "data-fetching" })).toContain(
      "@/lib/api/client"
    );
  });

  test("an unknown/empty topic lists the valid ones (never a bare failure)", () => {
    const r = doPullConventions({ topic: "styling" });

    expect(r).toContain("unknown topic");
    expect(r).toContain("component-anatomy");
    expect(r).toContain("no-casts");
  });
});
