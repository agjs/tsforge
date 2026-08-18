import { test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  resolveExemplars,
  clearExemplarCache,
} from "../src/loop/feedback/exemplar";
import type { ErrorSet } from "../src/validate";

const CLOCK_ERROR: ErrorSet = [
  {
    key: "src/app.ts:3:tsforge/no-bare-date-now",
    file: "src/app.ts",
    line: 3,
    rule: "tsforge/no-bare-date-now",
    message: "Direct `new Date()` (no args) is non-deterministic.",
  },
];

beforeEach(() => {
  clearExemplarCache();
});

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exemplar-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function write(dir: string, rel: string, text: string): Promise<void> {
  await mkdir(join(dir, dirname(rel)), { recursive: true });
  await Bun.write(join(dir, rel), text);
}

test("glob scan finds the conforming file and names the proving export", async () => {
  await withDir(async (dir) => {
    await write(
      dir,
      "src/lib/time.ts",
      "export function now(): number {\n  return Date.now();\n}\n"
    );

    const out = await resolveExemplars(CLOCK_ERROR, dir);

    expect(out.get("tsforge/no-bare-date-now")).toBe(
      "src/lib/time.ts (exports now())"
    );
  });
});

test("workspace map is preferred over scanning", async () => {
  await withDir(async (dir) => {
    await write(
      dir,
      "src/core/clock.ts",
      "export const getNow = (): number => 0;\n"
    );
    await write(
      dir,
      ".tsforge/workspace-map.json",
      JSON.stringify({
        meta: {},
        hubs: [],
        modules: {
          "src/core/clock.ts": {
            path: "src/core/clock.ts",
            exports: ["getNow"],
            imports: [],
            lineCount: 1,
            hasTests: false,
          },
        },
      })
    );

    const out = await resolveExemplars(CLOCK_ERROR, dir);

    expect(out.get("tsforge/no-bare-date-now")).toBe(
      "src/core/clock.ts (exports getNow())"
    );
  });
});

test("a map entry whose file was deleted falls back to nothing, not a dangling path", async () => {
  await withDir(async (dir) => {
    await write(
      dir,
      ".tsforge/workspace-map.json",
      JSON.stringify({
        meta: {},
        hubs: [],
        modules: {
          "src/gone/time.ts": {
            path: "src/gone/time.ts",
            exports: ["now"],
            imports: [],
            lineCount: 1,
            hasTests: false,
          },
        },
      })
    );

    const out = await resolveExemplars(CLOCK_ERROR, dir);

    expect(out.has("tsforge/no-bare-date-now")).toBe(false);
  });
});

test("silent omission when nothing conforms; node_modules never counts", async () => {
  await withDir(async (dir) => {
    await write(
      dir,
      "node_modules/pkg/time.ts",
      "export function now(): number {\n  return 0;\n}\n"
    );
    // A matching filename WITHOUT a proving export is not an exemplar either.
    await write(dir, "src/time.ts", "const now = 1;\n");

    const out = await resolveExemplars(CLOCK_ERROR, dir);

    expect(out.size).toBe(0);
  });
});

test("rules without an exemplar spec are absent", async () => {
  await withDir(async (dir) => {
    const errors: ErrorSet = [
      {
        key: "a.ts:1:TS2532",
        file: "a.ts",
        line: 1,
        rule: "TS2532",
        message: "Object is possibly 'undefined'.",
      },
    ];

    const out = await resolveExemplars(errors, dir);

    expect(out.size).toBe(0);
  });
});

test("positive cache pins the path across settles, and drops it when the file is deleted", async () => {
  await withDir(async (dir) => {
    await write(
      dir,
      "src/time.ts",
      "export function now(): number {\n  return 0;\n}\n"
    );

    const first = await resolveExemplars(CLOCK_ERROR, dir);

    expect(first.get("tsforge/no-bare-date-now")).toBe(
      "src/time.ts (exports now())"
    );

    // Same answer from cache.
    const second = await resolveExemplars(CLOCK_ERROR, dir);

    expect(second.get("tsforge/no-bare-date-now")).toBe(
      "src/time.ts (exports now())"
    );

    // Deleting the exemplar invalidates the cached hit instead of dangling.
    await rm(join(dir, "src/time.ts"));

    const third = await resolveExemplars(CLOCK_ERROR, dir);

    expect(third.has("tsforge/no-bare-date-now")).toBe(false);
  });
});
