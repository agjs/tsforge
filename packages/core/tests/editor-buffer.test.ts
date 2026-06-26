import { test, expect } from "bun:test";
import { EditorBuffer } from "../src/editor/buffer";

test("insert appends text and advances the cursor by graphemes", () => {
  const b = new EditorBuffer();

  b.insert("héllo"); // é = combining? use a precomposed char; 5 graphemes
  expect(b.getText()).toBe("héllo");
  expect(b.getCursor()).toEqual({ line: 0, col: 5 });
});

test("newline splits the current line at the cursor", () => {
  const b = new EditorBuffer("abcd");

  b.moveLeft(); // cursor before 'd' → col 3
  b.newline();
  expect(b.getText()).toBe("abc\nd");
  expect(b.getCursor()).toEqual({ line: 1, col: 0 });
});

test("deleteBackward joins lines at column 0", () => {
  const b = new EditorBuffer("ab\ncd");

  // cursor at end (line 1, col 2); move to line 1 col 0
  b.setText("ab\ncd");

  // place cursor at start of line 1:
  b.moveLeft();
  b.moveLeft(); // from end → col 0 of line 1
  b.deleteBackward();
  expect(b.getText()).toBe("abcd");
  expect(b.getCursor()).toEqual({ line: 0, col: 2 });
});

test("emoji is one grapheme for cursor + delete", () => {
  const b = new EditorBuffer();

  b.insert("a👍b");
  b.moveLeft(); // before 'b'
  b.deleteBackward(); // removes 👍 as one unit
  expect(b.getText()).toBe("ab");
});

// region: Task 2 — word/line/doc navigation + sticky-column vertical moves

test("moveWordLeft/Right stop at word boundaries", () => {
  const b = new EditorBuffer("foo bar baz");

  b.moveLineStart();
  b.moveWordRight();
  expect(b.getCursor().col).toBe(3); // end of "foo"
  b.moveWordRight();
  expect(b.getCursor().col).toBe(7); // end of "bar"
  b.moveWordLeft();
  expect(b.getCursor().col).toBe(4); // start of "bar"
});

test("moveUp keeps sticky column across a short line", () => {
  const b = new EditorBuffer("hello\nhi\nworld");

  b.moveDocEnd(); // line 2 (world), col 5
  b.moveUp(); // line 1 (hi) — clamps to col 2
  expect(b.getCursor()).toEqual({ line: 1, col: 2 });
  b.moveUp(); // line 0 (hello) — sticky restores col 5
  expect(b.getCursor()).toEqual({ line: 0, col: 5 });
});

test("moveDocStart/End jump to buffer ends", () => {
  const b = new EditorBuffer("a\nb\nc");

  b.moveDocStart();
  expect(b.getCursor()).toEqual({ line: 0, col: 0 });
  b.moveDocEnd();
  expect(b.getCursor()).toEqual({ line: 2, col: 1 });
});

// region: Task 3 — kill-ring + region deletes with yank/yank-pop

test("Ctrl-K (deleteToLineEnd) then yank round-trips", () => {
  const b = new EditorBuffer("hello world");

  b.moveLineStart();
  b.moveWordRight(); // col 5 (after hello)
  b.deleteToLineEnd();
  expect(b.getText()).toBe("hello");
  b.moveLineEnd();
  b.yank();
  expect(b.getText()).toBe("hello world");
});

test("deleteWordBackward removes the previous word", () => {
  const b = new EditorBuffer("foo bar");

  b.deleteWordBackward();
  expect(b.getText()).toBe("foo ");
});

// region: Task 4 — undo/redo with word-coalescing

test("undo reverts a word as one unit, redo restores it", () => {
  const b = new EditorBuffer();

  b.insert("h");
  b.insert("i"); // coalesced
  b.undo();
  expect(b.getText()).toBe("");
  b.redo();
  expect(b.getText()).toBe("hi");
});

test("space then word are separate undo units", () => {
  const b = new EditorBuffer();

  b.insert("a");
  b.insert(" ");
  b.insert("b");
  b.undo();
  expect(b.getText()).toBe("a ");
  b.undo();
  expect(b.getText()).toBe("a");
});

test("a yank is a single undo unit (no wasted undo step)", () => {
  const b = new EditorBuffer();

  b.insert("x");
  // set up the kill ring: kill some text so yank has content
  b.setText("ab");
  b.moveLineStart();
  b.deleteToLineEnd(); // kills "ab" → buffer ""
  b.insert("x"); // buffer "x"
  b.yank(); // buffer "xab"
  expect(b.getText()).toBe("xab");
  b.undo(); // ONE undo reverts the whole yank
  expect(b.getText()).toBe("x");
  b.undo(); // next undo reverts the "x" insert — NOT a wasted no-op
  expect(b.getText()).toBe("");
});
