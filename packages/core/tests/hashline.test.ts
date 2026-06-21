import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFileHash,
  formatHashHeader,
  parseHashHeader,
  isValidHash,
  normalizeHash,
} from "../src/files/hashline-format";
import {
  SessionSnapshotStore,
  parseHashlineEdit,
  applyHashlineEdit,
} from "../src/files/hashline";

describe("hashline-format", () => {
  test("computeFileHash: same content produces same hash", () => {
    const text = "function foo() {\n  return 42;\n}";
    const h1 = computeFileHash(text);
    const h2 = computeFileHash(text);

    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9A-F]{4}$/);
  });

  test("computeFileHash: different content produces different hash", () => {
    const h1 = computeFileHash("const x = 1;");
    const h2 = computeFileHash("const x = 2;");

    expect(h1).not.toBe(h2);
  });

  test("computeFileHash: trailing whitespace is normalized", () => {
    const h1 = computeFileHash("line1\nline2\n");
    const h2 = computeFileHash("line1  \nline2  \n");

    expect(h1).toBe(h2);
  });

  test("formatHashHeader: constructs correct format", () => {
    const header = formatHashHeader("src/foo.ts", "1A2B");

    expect(header).toBe("¶src/foo.ts#1A2B");
  });

  test("parseHashHeader: extracts path and hash", () => {
    const result = parseHashHeader("¶src/foo.ts#1A2B");

    expect(result).toEqual({ path: "src/foo.ts", hash: "1A2B" });
  });

  test("parseHashHeader: returns null for invalid format", () => {
    expect(parseHashHeader("src/foo.ts#1A2B")).toBeNull();
    expect(parseHashHeader("¶src/foo.ts")).toBeNull();
    expect(parseHashHeader("¶#1A2B")).toBeNull();
  });

  test("isValidHash: accepts 4-hex", () => {
    expect(isValidHash("1A2B")).toBe(true);
    expect(isValidHash("FFFF")).toBe(true);
    expect(isValidHash("0000")).toBe(true);
  });

  test("isValidHash: rejects non-hex", () => {
    expect(isValidHash("GGGG")).toBe(false);
    expect(isValidHash("1A2")).toBe(false);
    expect(isValidHash("1A2B3")).toBe(false);
  });

  test("normalizeHash: converts to uppercase", () => {
    expect(normalizeHash("1a2b")).toBe("1A2B");
    expect(normalizeHash("FfFf")).toBe("FFFF");
  });
});

describe("parseHashlineEdit", () => {
  test("parses replace operation", () => {
    const input = "¶src/foo.ts#1A2B\nreplace 1..2:\n+new line 1\n+new line 2";
    const result = parseHashlineEdit(input);

    expect(result.filePath).toBe("src/foo.ts");
    expect(result.fileHash).toBe("1A2B");
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({
      kind: "replace",
      startLine: 1,
      endLine: 2,
      lines: ["new line 1", "new line 2"],
    });
  });

  test("parses delete operation", () => {
    const input = "¶src/foo.ts#1A2B\ndelete 5..7";
    const result = parseHashlineEdit(input);

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({
      kind: "delete",
      startLine: 5,
      endLine: 7,
    });
  });

  test("parses single-line delete", () => {
    const input = "¶src/foo.ts#1A2B\ndelete 3";
    const result = parseHashlineEdit(input);

    expect(result.ops[0]).toMatchObject({
      kind: "delete",
      startLine: 3,
      endLine: 3,
    });
  });

  test("parses insert before", () => {
    const input = "¶src/foo.ts#1A2B\ninsert before 5:\n+new line";
    const result = parseHashlineEdit(input);

    expect(result.ops[0]).toMatchObject({
      kind: "insert",
      insertPos: "before",
      insertAnchor: 5,
      lines: ["new line"],
    });
  });

  test("parses insert after", () => {
    const input = "¶src/foo.ts#1A2B\ninsert after 10:\n+new line";
    const result = parseHashlineEdit(input);

    expect(result.ops[0]).toMatchObject({
      kind: "insert",
      insertPos: "after",
      insertAnchor: 10,
      lines: ["new line"],
    });
  });

  test("parses multiple operations", () => {
    const input =
      "¶src/foo.ts#1A2B\nreplace 1..2:\n+new\ndelete 5\ninsert before 10:\n+x";
    const result = parseHashlineEdit(input);

    expect(result.ops).toHaveLength(3);
  });

  test("handles lenient variants (no colon)", () => {
    const input = "¶src/foo.ts#1A2B\nreplace 1..2\n+new line";
    const result = parseHashlineEdit(input);

    expect(result.ops[0]?.kind).toBe("replace");
  });

  test("skips blank lines", () => {
    const input = "¶src/foo.ts#1A2B\n\n\nreplace 1..2:\n+new";
    const result = parseHashlineEdit(input);

    expect(result.ops).toHaveLength(1);
  });
});

describe("SessionSnapshotStore", () => {
  test("records and retrieves snapshots", () => {
    const store = new SessionSnapshotStore();
    const hash = store.record("src/foo.ts", "const x = 1;");

    expect(hash).toMatch(/^[0-9A-F]{4}$/);

    const snapshot = store.head("src/foo.ts");

    expect(snapshot).toBeTruthy();
    expect(snapshot?.text).toBe("const x = 1;");
    expect(snapshot?.hash).toBe(hash);
  });

  test("reuses hash for identical content", () => {
    const store = new SessionSnapshotStore();
    const h1 = store.record("src/foo.ts", "const x = 1;");
    const h2 = store.record("src/foo.ts", "const x = 1;");

    expect(h1).toBe(h2);
  });

  test("byHash retrieves a specific snapshot", () => {
    const store = new SessionSnapshotStore();
    const hash1 = store.record("src/foo.ts", "version 1");
    const hash2 = store.record("src/foo.ts", "version 2");

    const snap1 = store.byHash("src/foo.ts", hash1);
    const snap2 = store.byHash("src/foo.ts", hash2);

    expect(snap1?.text).toBe("version 1");
    expect(snap2?.text).toBe("version 2");
  });

  test("keeps max 4 versions per path", () => {
    const store = new SessionSnapshotStore();

    store.record("src/foo.ts", "v1");
    store.record("src/foo.ts", "v2");
    store.record("src/foo.ts", "v3");
    store.record("src/foo.ts", "v4");
    store.record("src/foo.ts", "v5");

    const v1 = store.byHash("src/foo.ts", computeFileHash("v1"));

    expect(v1).toBeNull(); // v1 was evicted
  });
});

describe("applyHashlineEdit", () => {
  test("a no-op edit (replace with identical content) reports changed:false and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\nline 3\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      // Replace line 2 with its EXACT current text → resolves to identical content.
      const input = `¶${filePath}#${hash}\nreplace 2..2:\n+line 2`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result).toMatchObject({ ok: true, changed: false });
      // The file is left byte-identical.
      expect(await Bun.file(join(dir, filePath)).text()).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a real replace reports changed:true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\nline 3\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\nreplace 2..2:\n+changed line`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result).toMatchObject({ ok: true, changed: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies replace operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\nline 3\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\nreplace 2..2:\n+replaced line`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      expect(newContent).toBe("line 1\nreplaced line\nline 3\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies delete operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\nline 3\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\ndelete 2..2`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      expect(newContent).toBe("line 1\nline 3\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies insert before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\ninsert before 2:\n+inserted`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      expect(newContent).toBe("line 1\ninserted\nline 2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies insert after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\ninsert after 1:\n+inserted`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      expect(newContent).toBe("line 1\ninserted\nline 2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies multiple operations bottom-up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "1\n2\n3\n4\n5\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\nreplace 4..4:\n+4new\ndelete 2..2`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      expect(newContent).toBe("1\n3\n4new\n5\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects out-of-bounds replace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();
      const hash = store.record(filePath, content);

      const input = `¶${filePath}#${hash}\nreplace 5..10:\n+new`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        hash,
        parsed.ops
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("out-of-bounds");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects stale hash without recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const content = "line 1\nline 2\n";

      await Bun.write(join(dir, filePath), content);

      const store = new SessionSnapshotStore();

      // Use a wrong hash
      const input = `¶${filePath}#XXXX\nreplace 1..1:\n+new`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        "XXXX",
        parsed.ops
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("stale-anchor");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers stale hash via 3-way merge (non-conflicting)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hashline-"));

    try {
      const filePath = "test.ts";
      const originalContent = "line 1\nline 2\nline 3\n";
      const store = new SessionSnapshotStore();
      const originalHash = store.record(filePath, originalContent);

      // File changed: line 4 added
      const liveContent = "line 1\nline 2\nline 3\nline 4\n";

      await Bun.write(join(dir, filePath), liveContent);

      // Edit against original: replace line 1
      const input = `¶${filePath}#${originalHash}\nreplace 1..1:\n+modified line 1`;
      const parsed = parseHashlineEdit(input);

      const result = await applyHashlineEdit(
        store,
        dir,
        filePath,
        originalHash,
        parsed.ops
      );

      expect(result.ok).toBe(true);
      const newContent = await Bun.file(join(dir, filePath)).text();

      // Should have the merge: line 1 modified, lines 2-4 from live
      expect(newContent).toBe("modified line 1\nline 2\nline 3\nline 4\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
