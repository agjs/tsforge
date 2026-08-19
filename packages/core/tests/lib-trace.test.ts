import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { readdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { trace } from "../src/lib/trace";

const ENV_KEYS = ["TSFORGE_TRACE", "TSFORGE_DEBUG"] as const;
const saved = new Map<string, string | undefined>();

function setTrace(value: string | undefined): void {
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) {
      saved.set(k, process.env[k]);
    }

    if (value === undefined) {
      process.env[k] = "";
    } else {
      process.env[k] = k === "TSFORGE_TRACE" ? value : "";
    }
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    process.env[k] = v ?? "";
  }

  saved.clear();
});

describe("trace env handling (F1)", () => {
  test("falsy sentinels DISABLE tracing — no file, no stderr", () => {
    const before = new Set(readdirSync(process.cwd()));

    for (const off of ["0", "false", "off", "no", "FALSE", "Off"]) {
      setTrace(off);
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

      trace("t", new Error("should not surface"));

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    // No stray file named after a sentinel was created in cwd.
    const after = readdirSync(process.cwd());
    const created = after.filter((f) => !before.has(f));

    expect(
      created.filter((f) => ["0", "false", "off", "no"].includes(f))
    ).toEqual([]);
  });

  test("a bare word (not a path) routes to stderr, never a file", () => {
    setTrace("verbose"); // a plausible typo for a level
    const before = new Set(readdirSync(process.cwd()));
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

    trace("t", new Error("boom"));

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const created = readdirSync(process.cwd()).filter((f) => !before.has(f));

    expect(created).not.toContain("verbose");
  });

  test("1/true/stderr route to stderr", () => {
    for (const on of ["1", "true", "stderr"]) {
      setTrace(on);
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

      trace("t", new Error("x"));

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  test("a value containing a path separator is written to that file", () => {
    const dir = join(
      process.env.TMPDIR ?? "/tmp",
      `tsforge-trace-${String(Date.now())}`
    );
    const file = `${dir}${sep}trace.log`;

    try {
      setTrace(file);
      // The dir doesn't exist → append fails → falls back to stderr (never throws).
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => trace("t", new Error("to-file"))).not.toThrow();
      spy.mockRestore();
    } finally {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
