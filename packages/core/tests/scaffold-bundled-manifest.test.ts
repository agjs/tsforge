import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundledManifest,
  parseManifest,
} from "../src/scaffold/boringstack-manifest";

describe("bundled scaffold manifest", () => {
  test("loads + validates the manifest shipped in src", () => {
    const m = loadBundledManifest();

    expect(m.manifestVersion).toBeGreaterThan(0);
    expect(m.repo).toContain("boringstack");
    expect(m.fields.length).toBeGreaterThan(10);
  });

  test("stays identical to the test fixture (drift guard)", () => {
    // The fixture is the test double; the src copy is the runtime bootstrap. They
    // mirror boringstack's source-of-truth manifest — if they diverge, this fails.
    const fixture = parseManifest(
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
          "utf8"
        )
      )
    );

    expect(loadBundledManifest()).toEqual(fixture);
  });
});
