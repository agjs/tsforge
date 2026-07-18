import { test, expect, describe } from "bun:test";
import { siblingScopeClause, judgeFeature } from "../src/loop/greenfield/judge";
import type { IProvider, IChatMessage } from "../src/inference";

/** A provider that records the messages it was given, for prompt assertions. */
function capturingProvider(reply: string): {
  provider: IProvider;
  seen: IChatMessage[];
} {
  const seen: IChatMessage[] = [];

  return {
    seen,
    provider: {
      async complete(messages) {
        seen.push(...messages);

        return { content: reply, toolCalls: [] };
      },
    },
  };
}

describe("siblingScopeClause", () => {
  test("empty when there are no siblings (single-entity build judges as before)", () => {
    expect(siblingScopeClause([])).toBe("");
    expect(siblingScopeClause(["", "  "])).toBe("");
  });

  test("names the siblings and forbids rejecting for a cross-slice link", () => {
    const clause = siblingScopeClause(["product", "invoice"]);

    expect(clause).toContain("product, invoice");
    expect(clause).toContain("separate slices");
    // Narrow exemption: don't reject for not BUILDING the other entities here…
    expect(clause).toMatch(/do NOT reject/iu);
    expect(clause).toContain("not BUILDING");
    // …and the FK-owner rule (a relationship is judged only in its owning slice).
    expect(clause).toMatch(/foreign key/u);
    // …but this feature's OWN requirements still stand (not a blanket pass).
    expect(clause).toMatch(/still require it|own responsibilities/u);
  });
});

describe("judgeFeature sibling scoping", () => {
  test("injects the sibling clause into the prompt when siblings are given", async () => {
    const { provider, seen } = capturingProvider('{"pass":true,"notes":"ok"}');

    await judgeFeature(provider, {
      feature: "A supplier that provides products",
      code: "export const supplier = {}",
      siblingEntities: ["product"],
    });

    const user = seen.find((m) => m.role === "user")?.content ?? "";

    // The judge must be told product belongs to another slice — the exact context
    // whose absence parked the inventory build (Supplier judged as missing a product link).
    expect(user).toContain("product");
    expect(user).toContain("not BUILDING");
  });

  test("omits the clause entirely with no siblings (unchanged single-entity prompt)", async () => {
    const { provider, seen } = capturingProvider('{"pass":true,"notes":"ok"}');

    await judgeFeature(provider, {
      feature: "A standalone note",
      code: "export const note = {}",
    });

    const user = seen.find((m) => m.role === "user")?.content ?? "";

    expect(user).not.toContain("separate slices");
    expect(user).toContain("A standalone note");
  });
});
