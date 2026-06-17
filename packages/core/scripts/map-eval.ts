// Value eval for `/map`: does priming the agent with the workspace map reduce
// exploration? Runs a brownfield fix through the real interactive Session loop
// WITH vs WITHOUT the map injected, counting tool calls before the first edit.
// The metric that justifies the feature — run it on a SMALL local model.
//
// Run: bun run packages/core/scripts/map-eval.ts   (uses ~/.tsforge/models.json)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference";
import { Session } from "../src/loop";
import { buildAndPersistMap, forgetMap } from "../src/codebase";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import type { ILoopEvent } from "../src/loop";

async function buildProvider(): Promise<OpenAICompatibleProvider> {
  const { entry } = await resolveActiveModel();

  return new OpenAICompatibleProvider({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? 8192,
    reasoning: entry.reasoning,
    reasoningEffort: entry.reasoningEffort,
    extraBody: entry.extraBody,
    extraHeaders: entry.extraHeaders,
  });
}

/** A multi-file repo where the bug is in a file the agent must FIND first. */
function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "map-eval-"));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true,"moduleResolution":"bundler"},"include":["src"]}'
  );
  writeFileSync(
    join(dir, "src/types.ts"),
    "export interface Line { qty: number; cents: number }\n"
  );
  // The bug lives here: should multiply qty*cents, but only sums cents.
  writeFileSync(
    join(dir, "src/totals.ts"),
    'import type { Line } from "./types";\nexport function lineTotal(l: Line): number {\n  return l.cents;\n}\n'
  );
  writeFileSync(
    join(dir, "src/cart.ts"),
    'import { lineTotal } from "./totals";\nimport type { Line } from "./types";\nexport function cartTotal(ls: Line[]): number {\n  return ls.reduce((n, l) => n + lineTotal(l), 0);\n}\n'
  );
  writeFileSync(
    join(dir, "src/cart.test.ts"),
    'import { test, expect } from "bun:test";\nimport { cartTotal } from "./cart";\ntest("multiplies qty by cents", () => {\n  expect(cartTotal([{ qty: 3, cents: 100 }])).toBe(300);\n});\n'
  );

  return dir;
}

async function runVariant(
  provider: OpenAICompatibleProvider,
  mapped: boolean
): Promise<{ preEditTools: number; status: string }> {
  const dir = setup();
  let preEditTools = 0;
  let firstEdit = false;

  const report = (e: ILoopEvent): void => {
    if (!firstEdit && (e.kind === "tool" || e.kind === "run")) {
      preEditTools += 1;
    }

    if (e.kind === "edit" || e.kind === "create") {
      firstEdit = true;
    }
  };

  try {
    await (mapped ? buildAndPersistMap(dir) : forgetMap(dir));

    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "bun test src/cart.test.ts",
      report,
      maxTurns: 12,
    });
    const result = await session.send(
      "The cart total test is failing. Find the bug and fix it."
    );

    return { preEditTools, status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const provider = await buildProvider();
const { entry } = await resolveActiveModel();

process.stdout.write(`map-eval: model ${entry.model}\n`);

const mappedRun = await runVariant(provider, true);
const plainRun = await runVariant(provider, false);

process.stdout.write(
  `\n=== map-eval (tool calls before first edit) ===\n` +
    `  mapped:   ${mappedRun.preEditTools} pre-edit tool calls (${mappedRun.status})\n` +
    `  unmapped: ${plainRun.preEditTools} pre-edit tool calls (${plainRun.status})\n`
);
