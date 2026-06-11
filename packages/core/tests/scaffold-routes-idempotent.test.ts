import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doScaffoldRoutes } from "../src/loop/tools/scaffold-routes";

/** scaffold_routes must be ADDITIVE: re-calling it (which the coverage gate
 *  induces, to add more entities) must NEVER overwrite a route the model already
 *  FILLED. The original bug clobbered every filled page back to a stub each call,
 *  trapping the build in an endless re-fill loop. */
test("re-calling scaffold_routes keeps filled routes, only adds missing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-idem-"));

  try {
    await mkdir(join(dir, "src", "routes"), { recursive: true });
    const ctx = {
      cwd: dir,
      files: ["**/*"],
      task: "t",
      report: (): void => undefined,
    };

    // 1. scaffold a stub, 2. model fills it with the real page
    await doScaffoldRoutes({ routes: ["/accounts"] }, ctx);
    const filled = "// REAL FILLED PAGE\nexport const x = 1;\n";

    await writeFile(join(dir, "src", "routes", "accounts.tsx"), filled);

    // 3. re-call with the existing route + a new one (what the coverage loop does)
    const result = await doScaffoldRoutes(
      { routes: ["/accounts", "/contacts"] },
      ctx
    );

    // the filled route is UNTOUCHED…
    expect(
      await readFile(join(dir, "src", "routes", "accounts.tsx"), "utf8")
    ).toBe(filled);
    // …and the new one was created
    expect(
      await Bun.file(join(dir, "src", "routes", "contacts.tsx")).exists()
    ).toBe(true);
    expect(result).toContain("kept 1 existing");
    expect(result).toContain("created 1 NEW");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
