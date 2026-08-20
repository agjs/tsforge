import { test, expect, describe } from "bun:test";
import { parseSpec } from "../src/spec";

describe("parseSpec", () => {
  test("reads frontmatter, stripping quotes", () => {
    const s = parseSpec(
      `---\nid: "007"\ntitle: Ticket tagging\nverify: bun run validate\n---\n`
    );

    expect(s.id).toBe("007");
    expect(s.title).toBe("Ticket tagging");
    expect(s.verify).toBe("bun run validate");
  });

  test("mode defaults to scratch, and reads `existing` (work-on-existing)", () => {
    expect(parseSpec(`---\nid: a\ntitle: t\n---\n`).mode).toBe("scratch");
    expect(parseSpec(`---\nid: a\ntitle: t\nmode: existing\n---\n`).mode).toBe(
      "existing"
    );
  });

  test("parses multiple tasks with accept + comma-split files", () => {
    const s = parseSpec(
      `---\nid: x\n---\n\n## Tasks\n1. [db] schema\n     accept: bun test db\n     files: a.ts, b.ts\n2. [api] routes\n     accept: bun test api\n     files: c.ts\n`
    );

    expect(s.tasks).toEqual([
      { id: "1", accept: "bun test db", files: ["a.ts", "b.ts"], context: [] },
      { id: "2", accept: "bun test api", files: ["c.ts"], context: [] },
    ]);
  });

  test("ignores acceptance-criteria lines like 'A1.'", () => {
    const s = parseSpec(
      `---\nid: x\n---\n\n## Acceptance criteria\nA1. a ticket can have tags\n\n## Tasks\n1. [db] schema\n     accept: bun test db\n     files: a.ts\n`
    );

    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]!.id).toBe("1");
  });

  test("a PLAIN numbered acceptance-criteria list is not scanned as phantom tasks", () => {
    // `1.`/`2.` under `## Acceptance criteria` used to be parsed as tasks with
    // empty accept, colliding ids with the real task and blocking the spec.
    // Task parsing is now scoped to the `## Tasks` section.
    const s = parseSpec(
      `---\nid: x\n---\n\n## Acceptance criteria\n1. user can log in\n2. errors show\n\n## Tasks\n1. real task\n     accept: bun test\n     files: a.ts\n`
    );

    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]?.id).toBe("1");
    expect(s.tasks[0]?.accept).toBe("bun test");
    expect(s.tasks[0]?.files).toEqual(["a.ts"]);
  });

  test("a CRLF-authored spec keeps its frontmatter (mode/id/verify not silently lost)", () => {
    // With a hard-coded `^---\n` regex a CRLF spec dropped ALL frontmatter,
    // flipping `mode: existing` to the default `scratch` — which DELETES the
    // task files. Line endings are normalized first.
    const crlf =
      "---\r\nid: fix-1\r\nverify: bun run validate\r\nmode: existing\r\n---\r\n\r\n## Tasks\r\n1. patch\r\n     accept: bun test\r\n     files: a.ts\r\n";
    const s = parseSpec(crlf);

    expect(s.mode).toBe("existing");
    expect(s.id).toBe("fix-1");
    expect(s.verify).toBe("bun run validate");
    expect(s.tasks[0]?.files).toEqual(["a.ts"]);
  });

  test("attaches the Acceptance criteria prose to each task as intent", () => {
    const s = parseSpec(
      `---\nid: x\n---\n\n## Acceptance criteria\nA1. discount is in CENTS: discounted = max(0, subtotal - discountCents).\n\n## Tasks\n1. [x] y\n     accept: bun test\n     files: a.ts\n`
    );

    expect(s.tasks[0]?.intent).toContain("discountCents");
  });

  test("parses context: as read-only files", () => {
    const s = parseSpec(
      `---\nid: x\n---\n\n## Tasks\n1. [x] y\n     accept: bun test\n     files: a.ts\n     context: a.test.ts, b.ts\n`
    );

    expect(s.tasks[0]?.context).toEqual(["a.test.ts", "b.ts"]);
  });

  test("tolerates missing frontmatter", () => {
    const s = parseSpec(
      `## Tasks\n1. [x] y\n     accept: echo hi\n     files: z.ts\n`
    );

    expect(s.id).toBe("");
    expect(s.tasks).toHaveLength(1);
  });
});
