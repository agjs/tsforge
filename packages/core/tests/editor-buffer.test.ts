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
