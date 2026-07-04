import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileLinter, buildGate } from "../src/gate";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");

const VIOLATING_SCHEMA = `import { pgTable, timestamp, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id"),
  createdAt: timestamp("created_at"),
});
`;

const CLEAN_SCHEMA = `import { pgTable, timestamp, text } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: text("id"),
  createdAt: timestamp("created_at", { mode: "date" }),
});
`;

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "tsforge-gate-packs-"));
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: { "drizzle-orm": "0.36.0" },
    })
  );
  writeFileSync(join(fixtureDir, "src", "schema.ts"), VIOLATING_SCHEMA);
  writeFileSync(join(fixtureDir, "src", "clean.ts"), CLEAN_SCHEMA);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface ILintedFile {
  messages: { ruleId: string | null }[];
}

function isLintedFileArray(value: unknown): value is ILintedFile[] {
  return Array.isArray(value);
}

/** Run the gate's CLI eslint invocation the same way the gate command does. */
async function runGateEslint(file: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "bun",
      ESLINT_BIN,
      "--no-config-lookup",
      "-c",
      STRICT_CONFIG,
      "--format",
      "json",
      file,
    ],
    {
      cwd: fixtureDir,
      env: { ...process.env, TSFORGE_PACKS: "drizzle" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isLintedFileArray(parsed)) {
    throw new Error(`unexpected eslint output: ${stdout.slice(0, 200)}`);
  }

  return parsed
    .flatMap((f) => f.messages)
    .map((m) => m.ruleId ?? "")
    .filter((id) => id.startsWith("tsforge/"));
}

describe("gate command construction", () => {
  test("includes TSFORGE_PACKS env prefix when packs are provided", async () => {
    const gate = await buildGate(fixtureDir, ["drizzle", "elysia"]);

    expect(gate.command).toContain("TSFORGE_PACKS='drizzle,elysia'");
    expect(gate.command).toContain("bun");
  });

  test("omits TSFORGE_PACKS when no packs are provided", async () => {
    const gate = await buildGate(fixtureDir, []);

    expect(gate.command).not.toContain("TSFORGE_PACKS");
    expect(gate.command).toContain("bun");
  });

  test("includes TSFORGE_RULE_OVERRIDES when rule overrides provided", async () => {
    const gate = await buildGate(fixtureDir, ["drizzle"], {
      "timestamp-must-specify-mode": "off",
    });

    expect(gate.command).toContain("TSFORGE_PACKS='drizzle'");
    expect(gate.command).toContain("TSFORGE_RULE_OVERRIDES='");
    expect(gate.command).toContain("timestamp-must-specify-mode");
  });

  test("omits TSFORGE_RULE_OVERRIDES when no overrides provided", async () => {
    const gate = await buildGate(fixtureDir, ["drizzle"]);

    expect(gate.command).not.toContain("TSFORGE_RULE_OVERRIDES");
  });
});

describe("makeFileLinter with packs (API path)", () => {
  test("flags a drizzle violation in a freshly written file", async () => {
    const linter = makeFileLinter("core", fixtureDir, ["drizzle"]);
    const problems = await linter(join(fixtureDir, "src", "schema.ts"));
    const ruleIds = problems.map((p) => p.ruleId);

    expect(ruleIds).toContain("tsforge/timestamp-must-specify-mode");
  });

  test("stays silent on a clean file for pack rules", async () => {
    const linter = makeFileLinter("core", fixtureDir, ["drizzle"]);
    const problems = await linter(join(fixtureDir, "src", "clean.ts"));
    const packProblems = problems.filter((p) =>
      p.ruleId.startsWith("tsforge/")
    );

    expect(packProblems).toEqual([]);
  });

  test("without packs, pack rules never fire", async () => {
    const linter = makeFileLinter("core", fixtureDir);
    const problems = await linter(join(fixtureDir, "src", "schema.ts"));
    const packProblems = problems.filter((p) =>
      p.ruleId.startsWith("tsforge/")
    );

    expect(packProblems).toEqual([]);
  });
});

/** Run a gate sub-command string through `sh -c` — exactly how the real gate
 *  runs it. This is what exercises the env-prefix shell quoting; running eslint
 *  via argv `env:{}` (as runGateEslint does) bypasses the shell and hides the
 *  bug. Returns the tsforge/* rule IDs eslint reported on stdout. */
async function runGateLintViaShell(command: string): Promise<string[]> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: fixtureDir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isLintedFileArray(parsed)) {
    throw new Error(`unexpected eslint output: ${stdout.slice(0, 200)}`);
  }

  return parsed
    .flatMap((f) => f.messages)
    .map((m) => m.ruleId ?? "")
    .filter((id) => id.startsWith("tsforge/"));
}

/** Pull the eslint sub-command (env prefix + invocation) out of the full gate
 *  command so it can be run alone and its JSON output parsed. */
function lintSubCommand(gateCommand: string): string {
  const part = gateCommand
    .split(" && ")
    .find((p) => p.includes("eslint") && p.includes("TSFORGE_PACKS"));

  if (part === undefined) {
    throw new Error(`no lint sub-command in: ${gateCommand}`);
  }

  return part;
}

// P1: rule overrides are handed to the bundled eslint config via a shell env
// prefix. The JSON value MUST be shell-quoted — an unquoted `{"x":"off"}` has its
// quotes stripped by `sh -c` to `{x:off}`, fails JSON.parse, and is silently
// ignored, so the override never applies. These run the REAL command via a shell.
describe("rule overrides take effect through the shell (P1b)", () => {
  test("override 'off' suppresses the rule through sh -c", async () => {
    const gate = await buildGate(fixtureDir, ["drizzle"], {
      "timestamp-must-specify-mode": "off",
    });
    const ruleIds = await runGateLintViaShell(lintSubCommand(gate.command));

    expect(ruleIds).not.toContain("tsforge/timestamp-must-specify-mode");
  }, 30_000);

  test("without the override the same shell path still flags it", async () => {
    const gate = await buildGate(fixtureDir, ["drizzle"]);
    const ruleIds = await runGateLintViaShell(lintSubCommand(gate.command));

    expect(ruleIds).toContain("tsforge/timestamp-must-specify-mode");
  }, 30_000);

  // P1b (security): single-quoting the JSON is not enough on its own — a `'` in an
  // override key (e.g. from a malicious tsforge.config.json) must be escaped, or it
  // breaks out of the quoting and injects shell commands run by `sh -c`.
  test("a single quote in an override key cannot inject shell commands", async () => {
    const marker = join(fixtureDir, "pwned.txt");

    rmSync(marker, { force: true });

    // Key crafted to break out of a naive single-quote wrap and run `touch`.
    const gate = await buildGate(fixtureDir, ["drizzle"], {
      "x'; touch pwned.txt; '": "off",
    });
    const proc = Bun.spawn(["sh", "-c", lintSubCommand(gate.command)], {
      cwd: fixtureDir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    // With proper escaping the key is inert data, not a command — no file written.
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 30_000);
});

describe("gate eslint CLI path (end-to-end)", () => {
  test("TSFORGE_PACKS=drizzle catches the violation through the bundled config", async () => {
    const ruleIds = await runGateEslint("src/schema.ts");

    expect(ruleIds).toContain("tsforge/timestamp-must-specify-mode");
  }, 30_000);

  test("clean file produces no tsforge violations through the CLI", async () => {
    const ruleIds = await runGateEslint("src/clean.ts");

    expect(ruleIds).toEqual([]);
  }, 30_000);
});
