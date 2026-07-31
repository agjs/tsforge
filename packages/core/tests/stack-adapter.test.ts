import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveStackAdapter,
  type IStackAdapter,
} from "../src/loop/planning/stack-adapter";
import { boringstackStackAdapter } from "../src/loop/boringstack/planning";

/** A fake adapter whose detection and id are fixed, so resolution order/precedence is
 *  observable without touching the filesystem. */
const fake = (id: string, matches: boolean): IStackAdapter => ({
  id,
  detect: async () => {
    await Promise.resolve();

    return matches;
  },
  // guidance-only constraint (no reserved entities) — these fakes exist for resolution
  // order, so planConstraints is never invoked; a valid minimal value keeps types honest.
  planConstraints: () => ({ guidance: id }),
});

describe("resolveStackAdapter", () => {
  test("returns the FIRST adapter that claims the project", async () => {
    const a = fake("a", false);
    const b = fake("b", true);
    const c = fake("c", true);

    const resolved = await resolveStackAdapter("/some/dir", [a, b, c]);

    expect(resolved?.id).toBe("b");
  });

  test("returns null when no adapter claims the project", async () => {
    const resolved = await resolveStackAdapter("/some/dir", [
      fake("a", false),
      fake("b", false),
    ]);

    expect(resolved).toBeNull();
  });

  test("returns null for an empty registry", async () => {
    expect(await resolveStackAdapter("/some/dir", [])).toBeNull();
  });
});

describe("boringstackStackAdapter", () => {
  test("is a well-formed IStackAdapter with the boringstack id", () => {
    const adapter: IStackAdapter = boringstackStackAdapter;

    expect(adapter.id).toBe("boringstack");
    expect(typeof adapter.detect).toBe("function");
    expect(typeof adapter.planConstraints).toBe("function");
  });

  test("planConstraints carries the reserved-entity rule and surfaces drops (fail-closed)", () => {
    const dropped: string[][] = [];
    const constraints = boringstackStackAdapter.planConstraints((ids) =>
      dropped.push([...ids])
    );

    // The boringstack constraint strips the reserved auth entities and REQUIRES a reporter.
    expect(constraints.reservedEntities?.has("user")).toBe(true);
    expect(constraints.guidance).toContain("BoringStack");
    constraints.onStripped?.(["user"]);
    expect(dropped).toEqual([["user"]]);
  });

  test("detect is false for a directory with no boringstack scaffold receipt", async () => {
    // No .tsforge/scaffold.json under a temp-ish path ⇒ not a boringstack project.
    expect(
      await boringstackStackAdapter.detect("/definitely/not/a/project")
    ).toBe(false);
  });

  test("detect is TRUE through the adapter method for a real boringstack scaffold receipt", async () => {
    // The true path THROUGH boringstackStackAdapter.detect (not just isBoringstackProject) —
    // so a detect stub that always returned false would fail here, catching a broken wiring
    // that kills greenfield interception.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-detect-"));

    try {
      await mkdir(join(dir, ".tsforge"), { recursive: true });
      await writeFile(
        join(dir, ".tsforge", "scaffold.json"),
        JSON.stringify({ archetype: "boringstack" })
      );

      expect(await boringstackStackAdapter.detect(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
