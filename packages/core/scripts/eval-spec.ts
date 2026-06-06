// Live multi-task eval against the local Qwen3.6. Not part of the test suite.
// Run: bun run packages/core/scripts/eval-spec.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference";
import { runSpec } from "../src/loop";
import type { ISpec } from "../src/spec";

const FILES: Record<string, string> = {
  "add.ts": `export function add(a: number, b: number): number {\n  return 0;\n}\n`,
  "add.test.ts": `import { test, expect } from "bun:test";\nimport { add } from "./add";\ntest("adds", () => { expect(add(2, 3)).toBe(5); });\n`,
  "mul.ts": `export function mul(a: number, b: number): number {\n  return 0;\n}\n`,
  "mul.test.ts": `import { test, expect } from "bun:test";\nimport { mul } from "./mul";\ntest("muls", () => { expect(mul(2, 3)).toBe(6); });\n`,
};

const spec: ISpec = {
  id: "math",
  title: "Math helpers",
  verify: "bun test",
  tasks: [
    { id: "add", accept: "bun test add.test.ts", files: ["add.ts"] },
    { id: "mul", accept: "bun test mul.test.ts", files: ["mul.ts"] },
  ],
};

const provider = new OpenAICompatibleProvider({
  baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
  model: process.env.TSFORGE_MODEL ?? "qwen3.6-35b-a3b",
});

const dir = await mkdtemp(join(tmpdir(), "tsforge-eval-spec-"));

try {
  for (const [name, content] of Object.entries(FILES)) {
    await Bun.write(join(dir, name), content);
  }

  const result = await runSpec(spec, dir, provider);

  console.log("spec status:", result.status);
  console.log("tasks:", JSON.stringify(result.results));
  console.log("add.ts:\n" + (await Bun.file(join(dir, "add.ts")).text()));
  console.log("mul.ts:\n" + (await Bun.file(join(dir, "mul.ts")).text()));
} finally {
  await rm(dir, { recursive: true, force: true });
}
