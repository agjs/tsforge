// Live "create from scratch" eval against the local Qwen3.6. Not in the suite.
// Run: bun run packages/core/scripts/eval-create.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference/openai-compatible";
import { runTask } from "../src/loop/run";

// Only the test exists. greet.ts must be CREATED by the model.
const TESTFILE = `import { test, expect } from "bun:test";
import { greet } from "./greet";
test("greets by name", () => {
  expect(greet("Sam")).toBe("Hello, Sam");
});
`;

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
  model: process.env.TSFORGE_MODEL ?? "qwen3.6-27b",
});

const dir = await mkdtemp(join(tmpdir(), "tsforge-eval-create-"));

try {
  await Bun.write(join(dir, "greet.test.ts"), TESTFILE);

  // The test is declared so the model can SEE the spec; greet.ts is the target.
  const result = await runTask(
    {
      id: "greet",
      accept: "bun test greet.test.ts",
      files: ["greet.ts", "greet.test.ts"],
    },
    dir,
    provider
  );

  console.log("result:", JSON.stringify(result));

  const created = Bun.file(join(dir, "greet.ts"));

  console.log(
    "greet.ts:\n" +
      ((await created.exists()) ? await created.text() : "(not created)")
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
