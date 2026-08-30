import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The requirement here is STRUCTURAL — "no module keeps its own copy" — so
 * behaviour tests cannot see it. Without this, the task passes by adding the
 * shared helper and changing nothing else, which is exactly what happened the
 * first time it was run.
 */

const SHARERS = [
  ["billing", "invoice.ts"],
  ["orders", "total.ts"],
  ["shipping", "quote.ts"],
] as const;

async function sourceOf(dir: string, file: string): Promise<string> {
  return Bun.file(join(import.meta.dir, "..", dir, file)).text();
}

for (const [dir, file] of SHARERS) {
  test(`${dir}/${file} uses the shared helper`, async () => {
    const src = await sourceOf(dir, file);

    expect(src).toContain("roundHalfUp");
    expect(src).toMatch(/from\s+"\.\.\/shared\/money"/u);
  });

  test(`${dir}/${file} keeps no rounding of its own`, async () => {
    const src = await sourceOf(dir, file);

    // Any local function declaration in these modules is the duplicate: each
    // one should be left with a single exported total.
    expect(src).not.toMatch(/^function /mu);
    expect(src).not.toContain("Math.floor");
  });
}

test("forecast is NOT rewired — it rounds half-even", async () => {
  const src = await sourceOf("reporting", "forecast.ts");

  expect(src).not.toContain("roundHalfUp");
});
