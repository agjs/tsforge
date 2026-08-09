import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorklist,
  resolveWorklistPath,
  slugifyItem,
  itemsToFeatures,
} from "../src/loop/worklist/parse";

describe("slugifyItem", () => {
  test("produces kebab-case ids that pass isFeatureId", () => {
    expect(slugifyItem("Stop rebuilding the whole HUD DOM")).toBe(
      "stop-rebuilding-the-whole-hud-dom"
    );
    expect(slugifyItem("`hud.ts` clears + re-inserts")).toBe(
      "hud-ts-clears-re-inserts"
    );
  });

  test("falls back when text has no alphanumerics", () => {
    expect(slugifyItem("!!!")).toBe("item");
  });
});

describe("parseWorklist", () => {
  test("parses markdown checkbox lists and skips checked items by default", () => {
    const md = `
## B. Polish

- [x] Already done item
- [ ] First open item
- [ ] Second open item
`;
    const items = parseWorklist(md);

    expect(items.map((i) => i.text)).toEqual([
      "First open item",
      "Second open item",
    ]);
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items[0]?.id).toBe("first-open-item");
  });

  test("includeDone keeps checked boxes", () => {
    const items = parseWorklist("- [x] Done\n- [ ] Open\n", {
      includeDone: true,
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.done).toBe(true);
    expect(items[1]?.done).toBe(false);
  });

  test("parses numbered lists with indented accept/files/context/fix", () => {
    const md = `
1. Build the parser
   accept: bun test packages/core/tests/worklist-parse.test.ts
   files: src/loop/worklist/parse.ts
   context: src/spec/parse.ts
   fix: reuse line-scanning shape
2. Drive the list
   accept: bun test
`;
    const items = parseWorklist(md);

    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("Build the parser");
    expect(items[0]?.accept).toBe(
      "bun test packages/core/tests/worklist-parse.test.ts"
    );
    expect(items[0]?.files).toEqual(["src/loop/worklist/parse.ts"]);
    expect(items[0]?.context).toEqual(["src/spec/parse.ts"]);
    expect(items[0]?.fix).toBe("reuse line-scanning shape");
    expect(items[1]?.accept).toBe("bun test");
  });

  test("checkbox items can carry indented accept/files", () => {
    const md = `
- [ ] Wire the HUD
  accept: bun test
  files: src/hud.ts, src/hud.test.ts
`;
    const items = parseWorklist(md);

    expect(items).toHaveLength(1);
    expect(items[0]?.accept).toBe("bun test");
    expect(items[0]?.files).toEqual(["src/hud.ts", "src/hud.test.ts"]);
  });

  test("disambiguates colliding slugs with numeric suffixes", () => {
    const items = parseWorklist("- [ ] Same\n- [ ] Same\n- [ ] Same\n");

    expect(items.map((i) => i.id)).toEqual(["same", "same-2", "same-3"]);
  });

  test("returns empty for malformed / non-list prose", () => {
    expect(parseWorklist("Just a paragraph.\n\n## Heading\n")).toEqual([]);
  });

  test("handles the cs-top-down PLAN.md shape (sections + nested checkboxes)", () => {
    const md = `
# Plan

### B2. Stop rebuilding the whole HUD DOM every frame

- [ ] \`hud.ts\` clears + re-inserts all HTML each frame.
- [ ] Tests: unit (root element not recreated).

### B3. Spatial partitioning (optional)

- [ ] Uniform grid for obstacle lookups.
`;
    const items = parseWorklist(md);

    expect(items).toHaveLength(3);
    expect(items[0]?.text).toContain("hud.ts");
    expect(items[2]?.text).toContain("Uniform grid");
  });

  test("parses plain bullets as open items", () => {
    const items = parseWorklist("## Plan\n\n- First\n- Second\n");

    expect(items.map((i) => i.text)).toEqual(["First", "Second"]);
  });
});

describe("resolveWorklistPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-wl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("explicit path wins when the file exists", async () => {
    const path = join(dir, "MY.md");

    await writeFile(path, "- [ ] a\n");

    expect(await resolveWorklistPath(dir, "MY.md")).toBe(path);
  });

  test("looks up PLAN.md then TASKS.md — not .specs/next.md", async () => {
    expect(await resolveWorklistPath(dir)).toBeNull();

    await mkdir(join(dir, ".specs"), { recursive: true });
    await writeFile(join(dir, ".specs", "next.md"), "- [ ] from specs\n");
    expect(await resolveWorklistPath(dir)).toBeNull();

    await writeFile(join(dir, "TASKS.md"), "- [ ] from tasks\n");
    expect(await resolveWorklistPath(dir)).toBe(join(dir, "TASKS.md"));

    await writeFile(join(dir, "PLAN.md"), "- [ ] from plan\n");
    expect(await resolveWorklistPath(dir)).toBe(join(dir, "PLAN.md"));
  });
});

describe("itemsToFeatures", () => {
  test("maps open items to IFeature with passes false and attempts 0", () => {
    const features = itemsToFeatures([
      { id: "a", text: "do a", done: false },
      { id: "b", text: "do b", done: false, accept: "bun test" },
    ]);

    expect(features).toEqual([
      { id: "a", desc: "do a", passes: false, attempts: 0 },
      { id: "b", desc: "do b", passes: false, attempts: 0 },
    ]);
  });
});
