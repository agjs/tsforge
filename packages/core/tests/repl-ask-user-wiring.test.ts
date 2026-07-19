import { test, expect } from "bun:test";
import { join } from "node:path";

// WS-C: the interactive REPL must offer ask_user, and it must SURVIVE /clear. The /clear
// path rebuilds Session.create WITHOUT reusing the init config, so it silently dropped
// interactive:true once (the panel caught it). Both Session.create sites in the REPL
// must set interactive:true. This source guard locks exactly that regression — the
// /clear rebuild lives inside the readline command loop and isn't unit-reachable.
test("both REPL Session.create sites (init + /clear) set interactive:true for ask_user", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  // Every Session.create in the REPL is an interactive human session.
  const createCount = (src.match(/Session\.create\(/g) ?? []).length;
  const interactiveCount = (src.match(/interactive: true/g) ?? []).length;

  expect(createCount).toBeGreaterThanOrEqual(2);
  expect(interactiveCount).toBe(createCount);
});
