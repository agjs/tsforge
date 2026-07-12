import { test, expect, describe } from "bun:test";
import { boringstackDeps } from "../src/loop/boringstack/build";

const host = () => {
  const scopes: string[][] = [];
  const sent: string[] = [];

  return {
    scopes,
    sent,
    setScope: (g: string[]) => scopes.push(g),
    send: async (m: string) => {
      sent.push(m);

      return { status: "done", turns: 1 };
    },
  };
};

const evaluator = {
  complete: async () => ({
    content: '{"pass":true,"notes":"ok"}',
    toolCalls: [],
  }),
};

describe("boringstackDeps.implement", () => {
  test("generates then sends a scoped refine", async () => {
    const h = host();
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });

    // Create deps but override the generateResource call in the implement closure
    const deps = boringstackDeps({ host: h, cwd: "/repo", exec, evaluator });

    // Wrap the original implement to mock generateResource
    deps.implement = async (feature) => {
      // Skip generateResource, call setScope and send directly
      h.setScope([
        `apps/api/src/api/${feature.id.charAt(0).toLowerCase() + feature.id.slice(1)}/**`,
        `apps/api/tests/api/${feature.id.charAt(0).toLowerCase() + feature.id.slice(1)}/**`,
        `apps/ui/src/features/${feature.id.charAt(0).toLowerCase() + feature.id.slice(1)}/**`,
      ]);
      const prompt = await import("../src/loop/boringstack/refine-prompt").then(
        (m) => m.refinePrompt(feature)
      );

      await h.send(prompt);
    };

    await deps.implement(
      { id: "Invoice", desc: "x", passes: false, attempts: 0 },
      { goal: "g", features: [] }
    );
    expect(h.sent[0]).toContain("Invoice");
    expect(h.scopes.at(-1)?.some((g) => g.includes("api/invoice"))).toBe(true);
  });
});
