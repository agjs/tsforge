import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves the type-aware gate stage catches IMPLICIT `any` flowing in from an
// untyped boundary (JSON.parse) — the gap `no-explicit-any` cannot see because
// there is no `any` token. Runs the bundled type-aware config exactly as the gate
// does (cwd at the project so projectService finds the tsconfig).
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const TYPE_AWARE_CONFIG = join(
  import.meta.dir,
  "..",
  "strict.type-aware.eslint.config.mjs"
);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src"],
});

// Implicit `any`: JSON.parse returns `any`, then it is walked + returned. No `any`
// token anywhere, tsc --strict passes — only no-unsafe-* catches it.
const UNSAFE = `export function parseUser(s: string): string {
  const data = JSON.parse(s);
  return data.profile.name.first;
}
`;

// The fix the model should reach for: validate the boundary, then it is typed.
const SAFE = `interface IUser {
  readonly profile: { readonly name: { readonly first: string } };
}

function isUser(value: unknown): value is IUser {
  return typeof value === "object" && value !== null && "profile" in value;
}

export function parseUser(s: string): string {
  const data: unknown = JSON.parse(s);

  if (!isUser(data)) {
    throw new Error("invalid user payload");
  }

  return data.profile.name.first;
}
`;

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = realpathSync(
    mkdtempSync(join(tmpdir(), "tsforge-gate-typesafety-"))
  );
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(join(fixtureDir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(fixtureDir, "src", "unsafe.ts"), UNSAFE);
  writeFileSync(join(fixtureDir, "src", "safe.ts"), SAFE);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface ILintMessage {
  ruleId: string | null;
}
interface ILintedFile {
  messages: ILintMessage[];
}

function isLintedFileArray(value: unknown): value is ILintedFile[] {
  return Array.isArray(value);
}

async function ruleIdsFor(file: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "bun",
      ESLINT_BIN,
      "--no-config-lookup",
      "-c",
      TYPE_AWARE_CONFIG,
      "--format",
      "json",
      file,
    ],
    { cwd: fixtureDir, stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isLintedFileArray(parsed)) {
    throw new Error(`unexpected eslint output: ${stdout.slice(0, 200)}`);
  }

  return parsed.flatMap((f) => f.messages).map((m) => m.ruleId ?? "");
}

describe("gate type-safety (implicit any)", () => {
  test("flags implicit `any` leaking from JSON.parse", async () => {
    const ruleIds = await ruleIdsFor(join(fixtureDir, "src", "unsafe.ts"));

    // At least one no-unsafe-* rule must fire on the untyped boundary data.
    expect(
      ruleIds.some((id) => id.startsWith("@typescript-eslint/no-unsafe-"))
    ).toBe(true);
  });

  test("stays silent once the boundary is validated", async () => {
    const ruleIds = await ruleIdsFor(join(fixtureDir, "src", "safe.ts"));

    expect(ruleIds.filter((id) => id.length > 0)).toEqual([]);
  });
});
