import { test, expect, describe } from "bun:test";
import { planResources } from "../src/loop/boringstack/plan-resources";

const provider = (replies: string[]) => {
  let i = 0;

  return {
    complete: async () => ({ content: replies[i++] ?? "", toolCalls: [] }),
  };
};

describe("planResources", () => {
  test("parses a resource checklist into IFeatures", async () => {
    const p = provider([
      JSON.stringify({
        resources: [
          { id: "Invoice", desc: "invoices CRUD" },
          { id: "Customer", desc: "customers CRUD" },
        ],
      }),
    ]);
    const feats = await planResources(p, "build a billing app");

    expect(feats.map((f) => f.id)).toEqual(["Invoice", "Customer"]);
    expect(feats.every((f) => !f.passes && f.attempts === 0)).toBe(true);
  });

  test("retries once on a malformed first reply", async () => {
    const p = provider([
      "not json",
      JSON.stringify({ resources: [{ id: "Invoice", desc: "x" }] }),
    ]);
    const feats = await planResources(p, "x");

    expect(feats).toHaveLength(1);
  });
});
