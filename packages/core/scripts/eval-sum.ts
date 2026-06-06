// Live eval against the local Qwen3.6. Not part of the test suite.
// Run: bun run packages/core/scripts/eval-sum.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider, PROVIDER_DEFAULTS } from "../src/inference";
import { runTask } from "../src/loop";

const BROKEN = `export function sum(a: number, b: number): number {
  return 0; // wrong on purpose
}
`;
const TESTFILE = `import { test, expect } from "bun:test";
import { sum } from "./sum";
test("adds", () => { expect(sum(2, 3)).toBe(5); });
`;

const EDIT_TOOL = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace an exact, unique snippet in a file.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["file", "oldString", "newString"],
    },
  },
};

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
  model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
});

// (1) Diagnostic: WITH full context (file + test), does it emit a valid edit?
console.log("=== (1) direct call, model given full context ===");
const diag = await provider.complete(
  [
    {
      role: "system",
      content:
        "You are a TypeScript engineer. Fix the bug by emitting an `edit` " +
        "tool call. oldString must match the file exactly and uniquely.",
    },
    {
      role: "user",
      content: `File sum.ts:\n${BROKEN}\nTest sum.test.ts:\n${TESTFILE}\nMake the test pass.`,
    },
  ],
  { temperature: 0, tools: [EDIT_TOOL] }
);

console.log("content:", JSON.stringify(diag.content));
console.log("toolCalls:", JSON.stringify(diag.toolCalls, null, 2));

// (2) The blind loop: current ModelAgent gets NO file content (only errors).
console.log("\n=== (2) full loop via ModelAgent (blind to file contents) ===");
const dir = await mkdtemp(join(tmpdir(), "tsforge-eval-"));

try {
  await Bun.write(join(dir, "sum.ts"), BROKEN);
  await Bun.write(join(dir, "sum.test.ts"), TESTFILE);

  const result = await runTask(
    { id: "sum", accept: "bun test sum.test.ts", files: ["sum.ts"] },
    dir,
    provider
  );

  console.log("result:", JSON.stringify(result));
  console.log("sum.ts after:\n" + (await Bun.file(join(dir, "sum.ts")).text()));
} finally {
  await rm(dir, { recursive: true, force: true });
}
