import { test, expect } from "bun:test";
import { runAccept } from "../src/validate/accept";

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
