import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "../src/lib/trace";

const SAVED_TRACE = process.env.TSFORGE_TRACE;
const SAVED_DEBUG = process.env.TSFORGE_DEBUG;

/** Restore one env var without a dynamic-key delete (lint: no-dynamic-delete). */
function restore(
  key: "TSFORGE_TRACE" | "TSFORGE_DEBUG",
  saved: string | undefined
): void {
  if (saved === undefined) {
    if (key === "TSFORGE_TRACE") {
      delete process.env.TSFORGE_TRACE;
    } else {
      delete process.env.TSFORGE_DEBUG;
    }

    return;
  }

  process.env[key] = saved;
}

afterEach(() => {
  // Restore env so the trace toggle doesn't leak between tests.
  restore("TSFORGE_TRACE", SAVED_TRACE);
  restore("TSFORGE_DEBUG", SAVED_DEBUG);
});

describe("trace (lib/trace)", () => {
  test("writes [scope] + message to the file path in TSFORGE_TRACE", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trace-")), "trace.log");

    process.env.TSFORGE_TRACE = file;
    delete process.env.TSFORGE_DEBUG;

    trace("buildTsService", new Error("boom"));

    expect(readFileSync(file, "utf8")).toContain("[buildTsService] boom");
  });

  test("is a silent no-op when neither env var is set", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trace-")), "none.log");

    delete process.env.TSFORGE_TRACE;
    delete process.env.TSFORGE_DEBUG;

    trace("scope", new Error("should not appear"));

    expect(existsSync(file)).toBe(false);
  });

  test("stringifies non-Error values", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trace-")), "trace.log");

    process.env.TSFORGE_TRACE = file;

    trace("meta", "plain string reason");

    expect(readFileSync(file, "utf8")).toContain("[meta] plain string reason");
  });

  test("TSFORGE_DEBUG is honoured when TSFORGE_TRACE is unset", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trace-")), "debug.log");

    delete process.env.TSFORGE_TRACE;
    process.env.TSFORGE_DEBUG = file;

    trace("run", new Error("via debug"));

    expect(readFileSync(file, "utf8")).toContain("[run] via debug");
  });
});
