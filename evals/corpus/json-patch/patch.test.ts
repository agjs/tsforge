import { test, expect } from "bun:test";
import { applyPatch, PatchError } from "./patch";
import { decodeSegment, parsePointer } from "./pointer";

test("decodes ~1 as slash and ~0 as tilde, in that order", () => {
  expect(decodeSegment("a~1b")).toBe("a/b");
  expect(decodeSegment("a~0b")).toBe("a~b");
  // The classic trap: ~01 must decode to ~1, NOT to /.
  expect(decodeSegment("~01")).toBe("~1");
});

test("parses the whole-document pointer as no segments", () => {
  expect(parsePointer("")).toEqual([]);
  expect(parsePointer("/a/0/b")).toEqual(["a", "0", "b"]);
});

test("add creates and overwrites object keys", () => {
  expect(applyPatch({ a: 1 }, [{ op: "add", path: "/b", value: 2 }])).toEqual({
    a: 1,
    b: 2,
  });
  expect(applyPatch({ a: 1 }, [{ op: "add", path: "/a", value: 9 }])).toEqual({
    a: 9,
  });
});

test("add to an array index inserts rather than overwrites", () => {
  expect(
    applyPatch({ xs: [1, 2, 3] }, [{ op: "add", path: "/xs/1", value: 9 }])
  ).toEqual({ xs: [1, 9, 2, 3] });
});

test("add with - appends", () => {
  expect(
    applyPatch({ xs: [1] }, [{ op: "add", path: "/xs/-", value: 2 }])
  ).toEqual({ xs: [1, 2] });
});

test("remove shifts an array down", () => {
  expect(
    applyPatch({ xs: [1, 2, 3] }, [{ op: "remove", path: "/xs/0" }])
  ).toEqual({ xs: [2, 3] });
});

test("does not mutate the input document", () => {
  const doc = { a: { b: [1, 2] } };
  const before = JSON.stringify(doc);

  applyPatch(doc, [{ op: "add", path: "/a/b/-", value: 3 }]);

  expect(JSON.stringify(doc)).toBe(before);
});

test("move and copy", () => {
  expect(
    applyPatch({ a: 1, b: {} }, [{ op: "move", from: "/a", path: "/b/a" }])
  ).toEqual({ b: { a: 1 } });
  expect(
    applyPatch({ a: 1, b: {} }, [{ op: "copy", from: "/a", path: "/b/a" }])
  ).toEqual({ a: 1, b: { a: 1 } });
});

test("test compares deeply, ignoring object key order", () => {
  const doc = { a: { x: 1, y: 2 } };

  expect(
    applyPatch(doc, [{ op: "test", path: "/a", value: { y: 2, x: 1 } }])
  ).toEqual(doc);
});

test("test treats array order as significant", () => {
  expect(() =>
    applyPatch({ xs: [1, 2] }, [{ op: "test", path: "/xs", value: [2, 1] }])
  ).toThrow(PatchError);
});

test("a failed op leaves the document untouched", () => {
  const doc = { a: 1 };
  const ops = [
    { op: "add" as const, path: "/b", value: 2 },
    { op: "test" as const, path: "/a", value: 999 },
  ];

  expect(() => applyPatch(doc, ops)).toThrow(PatchError);
  expect(doc).toEqual({ a: 1 });
});

test("errors name the offending pointer", () => {
  const err = (() => {
    try {
      applyPatch({}, [{ op: "remove", path: "/nope" }]);

      return null;
    } catch (e: unknown) {
      return e instanceof PatchError ? e : null;
    }
  })();

  expect(err).not.toBeNull();
  expect(err?.path).toBe("/nope");
});

test("rejects a path through a missing parent", () => {
  expect(() =>
    applyPatch({}, [{ op: "add", path: "/a/b", value: 1 }])
  ).toThrow(PatchError);
});

test("rejects an out-of-range array index", () => {
  expect(() =>
    applyPatch({ xs: [1] }, [{ op: "add", path: "/xs/5", value: 1 }])
  ).toThrow(PatchError);
});

test("rejects moving a location into itself", () => {
  expect(() =>
    applyPatch({ a: { b: 1 } }, [{ op: "move", from: "/a", path: "/a/b" }])
  ).toThrow(PatchError);
});
