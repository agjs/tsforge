import { test, expect, describe } from "bun:test";
import { runAccept, parseGateTimeout } from "../src/validate";

test("passes when the command exits 0, capturing output", async () => {
  const r = await runAccept({ id: "1", accept: "echo ok", files: [] }, ".");

  expect(r.passed).toBe(true);
  expect(r.output).toContain("ok");
});

test("fails when the command exits non-zero, capturing stderr", async () => {
  const r = await runAccept(
    { id: "1", accept: "echo boom >&2; exit 1", files: [] },
    "."
  );

  expect(r.passed).toBe(false);
  expect(r.output).toContain("boom");
});

test("a spawn failure (unknown binary) is a RED gate, never a pass", async () => {
  const r = await runAccept(
    { id: "1", accept: "definitely-not-a-binary-xyz", files: [] },
    "."
  );

  expect(r.passed).toBe(false);
  expect(r.output.length).toBeGreaterThan(0);
});

test("a hung gate command is killed at the timeout and fails with the note", async () => {
  const prev = process.env.TSFORGE_GATE_TIMEOUT_MS;

  process.env.TSFORGE_GATE_TIMEOUT_MS = "150";

  try {
    const r = await runAccept({ id: "1", accept: "sleep 5", files: [] }, ".");

    expect(r.passed).toBe(false);
    expect(r.output).toContain("gate killed after 150ms timeout");
  } finally {
    if (prev === undefined) {
      delete process.env.TSFORGE_GATE_TIMEOUT_MS;
    } else {
      process.env.TSFORGE_GATE_TIMEOUT_MS = prev;
    }
  }
});

describe("parseGateTimeout", () => {
  const DEFAULT = 600_000;

  test("absent or blank falls back to the default (blank must NOT disable the timeout)", () => {
    // Number("") === 0 — without the blank guard, `export TSFORGE_GATE_TIMEOUT_MS=`
    // silently removed the only bound on a hung gate.
    expect(parseGateTimeout(undefined)).toBe(DEFAULT);
    expect(parseGateTimeout("")).toBe(DEFAULT);
    expect(parseGateTimeout("   ")).toBe(DEFAULT);
  });

  test("explicit values parse; only an explicit 0 disables", () => {
    expect(parseGateTimeout("0")).toBe(0);
    expect(parseGateTimeout("250")).toBe(250);
    expect(parseGateTimeout("junk")).toBe(DEFAULT);
    expect(parseGateTimeout("-5")).toBe(DEFAULT);
  });
});
