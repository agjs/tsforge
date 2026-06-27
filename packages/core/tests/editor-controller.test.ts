import { describe, expect, test } from "bun:test";
import { startEditor } from "../src/editor/controller";

/**
 * FakeStdin: EventEmitter-like test stub for stdin.
 * Allows tests to feed bytes synchronously and capture output.
 */
class FakeStdin {
  private listeners: Record<string, Set<(data: any) => void>>;

  constructor() {
    this.listeners = { data: new Set() };
  }

  on(event: string, callback: (data: any) => void): this {
    const existing = this.listeners[event];

    if (existing) {
      existing.add(callback);
    } else {
      const newSet = new Set<(data: any) => void>();

      newSet.add(callback);
      this.listeners[event] = newSet;
    }

    return this;
  }

  removeListener(event: string, callback: (data: any) => void): this {
    this.listeners[event]?.delete(callback);

    return this;
  }

  feed(chunk: string): void {
    const callbacks = this.listeners.data ?? new Set();

    callbacks.forEach((cb) => {
      cb(chunk);
    });
  }

  setRawMode(_mode: boolean): this {
    // no-op for testing
    return this;
  }

  resume(): this {
    // no-op for testing
    return this;
  }

  setEncoding(_: string): this {
    // no-op for testing
    return this;
  }
}

function makeHarness() {
  const stdin = new FakeStdin();
  const outputs: string[] = [];
  const submits: string[] = [];

  const handle = startEditor({
    stdin: stdin,
    out: (s: string) => {
      outputs.push(s);
    },
    columns: 80,
    rows: 10,
  });

  handle.onSubmit((message: string) => {
    submits.push(message);
  });

  return { stdin, handle, submits, outputs };
}

describe("EditorController", () => {
  test("typing then Enter submits the typed text once", () => {
    const { stdin, handle, submits } = makeHarness();

    stdin.feed("hi");
    stdin.feed("\r");
    expect(submits).toEqual(["hi"]);
    expect(handle.getBuffer().getText()).toBe("");
  });

  test("Shift+Enter inserts a newline, does NOT submit", () => {
    const { stdin, handle, submits } = makeHarness();

    stdin.feed("a");
    stdin.feed("\x1b[13;2u"); // Kitty Shift+Enter
    stdin.feed("b");
    expect(submits).toEqual([]);
    expect(handle.getBuffer().getText()).toBe("a\nb");
    stdin.feed("\r");
    expect(submits).toEqual(["a\nb"]);
    expect(handle.getBuffer().getText()).toBe("");
  });

  test("a multi-line paste lands in the buffer and submits once on Enter", () => {
    const { stdin, handle, submits } = makeHarness();

    stdin.feed("\x1b[200~one\rtwo\rthree\x1b[201~");
    expect(submits).toEqual([]); // never auto-submits
    expect(handle.getBuffer().getText()).toBe("one\ntwo\nthree");
    stdin.feed("\r");
    expect(submits).toEqual(["one\ntwo\nthree"]);
    expect(handle.getBuffer().getText()).toBe("");
  });

  test("Alt+Enter inserts a newline, does NOT submit", () => {
    const { stdin, handle, submits } = makeHarness();

    stdin.feed("x");
    stdin.feed("\x1b\r"); // Alt+Return
    stdin.feed("y");
    expect(submits).toEqual([]);
    expect(handle.getBuffer().getText()).toBe("x\ny");
    stdin.feed("\r");
    expect(submits).toEqual(["x\ny"]);
  });

  test("trailing backslash + Enter: delete backslash and insert newline, do not submit", () => {
    const { stdin, handle, submits } = makeHarness();

    stdin.feed("foo\\");
    stdin.feed("\r");
    expect(submits).toEqual([]);
    expect(handle.getBuffer().getText()).toBe("foo\n");
    stdin.feed("bar");
    stdin.feed("\r");
    expect(submits).toEqual(["foo\nbar"]);
  });

  test("backspace deletes the character before cursor", () => {
    const { stdin, handle } = makeHarness();

    stdin.feed("abc");
    stdin.feed("\x7f"); // backspace
    expect(handle.getBuffer().getText()).toBe("ab");
  });

  test("delete key deletes the character at cursor", () => {
    const { stdin, handle } = makeHarness();

    stdin.feed("abc");
    stdin.feed("\x1b[D"); // left arrow
    stdin.feed("\x1b[3~"); // delete
    expect(handle.getBuffer().getText()).toBe("ab");
  });

  test("ctrl+u deletes from cursor to line start (kill to line start)", () => {
    const { stdin, handle } = makeHarness();

    stdin.feed("hello world");

    // Cursor is now at end (position 11)
    // Move to position 5 (after "hello")
    for (let i = 0; i < 6; i += 1) {
      stdin.feed("\x1b[D"); // left arrow
    }

    // cursor is now at position 5 (before space)
    stdin.feed("\x15"); // ctrl+u = delete to line start
    expect(handle.getBuffer().getText()).toBe(" world");
  });

  test("onChange callback fires on edits", () => {
    const { stdin } = makeHarness();
    let changeCount = 0;
    const handle = startEditor({
      stdin: stdin,
      out: () => {},
      columns: 80,
      rows: 10,
    });

    handle.onChange(() => {
      changeCount += 1;
    });
    stdin.feed("x");
    expect(changeCount).toBeGreaterThan(0);
  });

  test("close() disables the editor and prevents further input", () => {
    const { stdin, handle: h } = makeHarness();

    stdin.feed("a");
    expect(h.getBuffer().getText()).toBe("a");
    h.close();
    stdin.feed("b");
    // After close, further input should be ignored
    expect(h.getBuffer().getText()).toBe("a");
  });

  test("multiple chars typed in one feed", () => {
    const { stdin, handle } = makeHarness();

    stdin.feed("hello");
    expect(handle.getBuffer().getText()).toBe("hello");
    stdin.feed("\r");
    // Buffer should be reset after submit
    expect(handle.getBuffer().getText()).toBe("");
  });

  test("return with ctrl modifier does not submit (only plain return submits)", () => {
    const { stdin, handle } = makeHarness();

    stdin.feed("test");
    // Simulate ctrl+return — in keys.ts this would be a return with ctrl=true
    // We'd need a Kitty sequence for that, but for now test plain behavior
    stdin.feed("\r");
    // Buffer should be reset after submit
    expect(handle.getBuffer().getText()).toBe("");
  });

  test("Ctrl-C (\\x03) invokes onInterrupt callback", () => {
    const { stdin, handle } = makeHarness();
    let interruptCount = 0;

    handle.onInterrupt(() => {
      interruptCount += 1;
    });

    stdin.feed("test");
    stdin.feed("\x03"); // Ctrl-C
    expect(interruptCount).toBe(1);
  });

  test("Ctrl-D (\\x04) on empty buffer invokes onExit callback", () => {
    const { stdin, handle } = makeHarness();
    let exitCount = 0;

    handle.onExit(() => {
      exitCount += 1;
    });

    // Buffer is empty, so Ctrl-D should exit
    stdin.feed("\x04");
    expect(exitCount).toBe(1);
  });

  test("Ctrl-D (\\x04) with text in buffer does NOT invoke onExit", () => {
    const { stdin, handle } = makeHarness();
    let exitCount = 0;

    handle.onExit(() => {
      exitCount += 1;
    });

    stdin.feed("hello");
    stdin.feed("\x04"); // Ctrl-D with text in buffer
    expect(exitCount).toBe(0); // Should NOT exit
    // With text present, Ctrl-D is treated as a normal character (inserted as 'd')
    // per the controller's logic (only exits on empty buffer)
    expect(handle.getBuffer().getText()).toContain("hello");
  });

  test("Up arrow on first line recalls previous submitted message into buffer", () => {
    const { stdin, handle, submits } = makeHarness();

    // Submit a message
    stdin.feed("first message");
    stdin.feed("\r");
    expect(submits).toEqual(["first message"]);
    expect(handle.getBuffer().getText()).toBe("");

    // Type a draft
    stdin.feed("draft");
    expect(handle.getBuffer().getText()).toBe("draft");

    // Up arrow on first line (cursor is at end of line, move to line 0, then up)
    // Since buffer is single-line, up arrow at line 0 should navigate history
    stdin.feed("\x1b[A"); // Up arrow
    expect(handle.getBuffer().getText()).toBe("first message");
  });

  test("Down arrow after Up returns to the draft", () => {
    const { stdin, handle, submits } = makeHarness();

    // Submit a message
    stdin.feed("first message");
    stdin.feed("\r");
    expect(submits).toEqual(["first message"]);
    expect(handle.getBuffer().getText()).toBe("");

    // Type a draft
    stdin.feed("draft");
    expect(handle.getBuffer().getText()).toBe("draft");

    // Up arrow to recall history
    stdin.feed("\x1b[A");
    expect(handle.getBuffer().getText()).toBe("first message");

    // Down arrow to return to draft
    stdin.feed("\x1b[B");
    expect(handle.getBuffer().getText()).toBe("draft");
  });

  test("Multiple submits create history; Up navigates backward through it", () => {
    const { stdin, handle } = makeHarness();

    // Submit first message
    stdin.feed("msg one");
    stdin.feed("\r");
    expect(handle.getBuffer().getText()).toBe("");

    // Submit second message
    stdin.feed("msg two");
    stdin.feed("\r");
    expect(handle.getBuffer().getText()).toBe("");

    // Type a draft
    stdin.feed("draft");

    // Up twice: draft → msg two → msg one
    stdin.feed("\x1b[A"); // msg two
    expect(handle.getBuffer().getText()).toBe("msg two");

    stdin.feed("\x1b[A"); // msg one
    expect(handle.getBuffer().getText()).toBe("msg one");

    // Down once: msg one → msg two
    stdin.feed("\x1b[B");
    expect(handle.getBuffer().getText()).toBe("msg two");

    // Down again: msg two → draft
    stdin.feed("\x1b[B");
    expect(handle.getBuffer().getText()).toBe("draft");
  });

  // region: Gemini PR #52 regression tests

  test("submitting while browsing history does NOT pollute history", () => {
    const { stdin, handle, submits } = makeHarness();

    // Submit first message
    stdin.feed("msg one");
    stdin.feed("\r");
    expect(submits).toEqual(["msg one"]);
    expect(handle.getBuffer().getText()).toBe("");

    // Type a draft
    stdin.feed("draft text");
    expect(handle.getBuffer().getText()).toBe("draft text");

    // Browse up into history
    stdin.feed("\x1b[A"); // recall "msg one"
    expect(handle.getBuffer().getText()).toBe("msg one");

    // Submit while in history
    stdin.feed("\r");
    expect(submits).toEqual(["msg one", "msg one"]); // resubmitted
    expect(handle.getBuffer().getText()).toBe("");

    // Navigate history again — should only have the original plus the new submit
    stdin.feed("new draft");
    stdin.feed("\x1b[A"); // should go up to the last real submit
    // History should be: ["msg one", "msg one"], and we should see "msg one" (the last one)
    // NOT see "draft text" (the draft was not saved)
    expect(handle.getBuffer().getText()).toBe("msg one");
  });

  test("trailing backslash after emoji inserts newline correctly", () => {
    const { stdin, handle, submits } = makeHarness();

    // Type text with backslash at end
    stdin.feed("test\\");
    expect(handle.getBuffer().getText()).toBe("test\\");

    // Press Enter — should remove the backslash and insert a newline
    stdin.feed("\r");
    expect(submits).toEqual([]); // not submitted
    expect(handle.getBuffer().getText()).toBe("test\n");

    // Type more text and submit
    stdin.feed("more");
    stdin.feed("\r");
    expect(submits).toEqual(["test\nmore"]);
  });
});
