import { appendFileSync } from "node:fs";
import { EditorBuffer } from "./buffer";
import { decodeKeys } from "./keys";
import { createPasteScanner } from "./paste";
import { renderEditor } from "./view";
import { graphemes } from "./segments";

export interface IEditorHandle {
  onSubmit(cb: (message: string) => void): void;
  onChange(cb: () => void): void;
  onInterrupt(cb: () => void): void;
  onExit(cb: () => void): void;
  getBuffer(): EditorBuffer;
  close(): void;
}

export interface IStdin {
  on(event: string, callback: (data: string) => void): void;
  removeListener?(event: string, callback: (data: string) => void): void;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  setEncoding?(encoding: string): void;
}

export interface IStartEditorDeps {
  stdin: IStdin;
  out: (s: string) => void;
  renderEditor?: (
    lines: string[],
    cursorRow: number,
    cursorCol: number
  ) => void;
  columns?: number;
  rows?: number;
  openPalette?: () => Promise<void>;
  openFilePicker?: () => Promise<void>;
}

type KeyAction = (buffer: EditorBuffer) => void;

/** Debug logging helper: append to TSFORGE_EDITOR_DEBUG if set. */
function debugLog(msg: string): void {
  const path = process.env.TSFORGE_EDITOR_DEBUG;

  if (path !== undefined) {
    appendFileSync(path, `${msg}\n`);
  }
}

/**
 * Build a dispatch table: normalized key string → buffer action.
 * Maps keys (possibly with modifiers) to EditorBuffer method calls.
 */
function buildKeyDispatchTable(): Map<string, KeyAction> {
  const table = new Map<string, KeyAction>();

  // Basic editing
  table.set("backspace", (buf) => {
    buf.deleteBackward();
  });
  table.set("delete", (buf) => {
    buf.deleteForward();
  });
  table.set("tab", (buf) => {
    buf.insert("\t");
  });

  // Motion keys — note: up/down are handled specially in handleCharKey
  // when at buffer edges for history navigation
  table.set("left", (buf) => {
    buf.moveLeft();
  });
  table.set("right", (buf) => {
    buf.moveRight();
  });
  table.set("home", (buf) => {
    buf.moveLineStart();
  });
  table.set("end", (buf) => {
    buf.moveLineEnd();
  });

  // Ctrl+left/right → word motion
  table.set("ctrl+left", (buf) => {
    buf.moveWordLeft();
  });
  table.set("ctrl+right", (buf) => {
    buf.moveWordRight();
  });

  // Ctrl+home/end → doc start/end
  table.set("ctrl+home", (buf) => {
    buf.moveDocStart();
  });
  table.set("ctrl+end", (buf) => {
    buf.moveDocEnd();
  });

  // Kill/delete word operations (emacs-style)
  table.set("ctrl+w", (buf) => {
    buf.deleteWordBackward();
  }); // kill word backward
  table.set("alt+d", (buf) => {
    buf.deleteWordForward();
  }); // kill word forward
  table.set("ctrl+u", (buf) => {
    buf.deleteToLineStart();
  }); // kill to line start
  table.set("ctrl+k", (buf) => {
    buf.deleteToLineEnd();
  }); // kill to line end

  // Yank operations
  table.set("ctrl+y", (buf) => {
    buf.yank();
  }); // yank (paste from kill ring)
  table.set("alt+y", (buf) => {
    buf.yankPop();
  }); // yank-pop (rotate kill ring)

  // Undo/redo
  table.set("ctrl+z", (buf) => {
    buf.undo();
  });
  table.set("ctrl+shift+z", (buf) => {
    buf.redo();
  });

  return table;
}

export function startEditor(deps: IStartEditorDeps): IEditorHandle {
  const {
    stdin,
    out,
    renderEditor: renderEditorFn,
    columns = 80,
    rows = 10,
    openPalette,
    openFilePicker,
  } = deps;

  const buffer = new EditorBuffer();
  const pasteScanner = createPasteScanner();
  const keyDispatchTable = buildKeyDispatchTable();

  let isOpen = true;
  const submitCallbacks: ((message: string) => void)[] = [];
  const changeCallbacks: (() => void)[] = [];
  const interruptCallbacks: (() => void)[] = [];
  const exitCallbacks: (() => void)[] = [];

  // In-session history: submitted messages for up/down navigation
  const history: string[] = [];
  let historyIndex = -1; // -1 = not in history, >= 0 = viewing history item
  let draftText: string | null = null;
  let dataListener: ((chunk: string) => void) | null = null;

  function repaint(): void {
    if (!isOpen) {
      return;
    }

    const { line, col } = buffer.getCursor();
    const lines = buffer.getText().split("\n");

    const frame = renderEditor(
      {
        lines,
        cursorLine: line,
        cursorCol: col,
      },
      {
        columns,
        maxRows: rows,
        color: true,
      }
    );

    if (renderEditorFn) {
      debugLog(
        `[repaint] rows=${frame.rows} cursorRow=${frame.cursorRow} cursorCol=${frame.cursorCol} frame=${JSON.stringify(frame.frame)}`
      );

      // Extract visual lines from the rendered frame (simple split on \n)
      const visualLines = frame.frame.split("\n");

      renderEditorFn(visualLines, frame.cursorRow, frame.cursorCol);
    } else {
      // Fallback: stream the raw frame (the buggy path, used if renderEditor not provided)
      out(frame.frame);
    }
  }

  function notifyChange(): void {
    changeCallbacks.forEach((cb) => {
      cb();
    });
  }

  // Save the current buffer as a history item and emit onSubmit callbacks
  function saveToHistory(message: string): void {
    history.push(message);
    draftText = null;
    historyIndex = -1;
  }

  // Navigate history: up arrow when cursor is on first line → prev item, down arrow when on last line → next

  function navigateHistoryUp(): void {
    if (historyIndex === -1) {
      // Save current draft before entering history
      draftText = buffer.getText();
      historyIndex = history.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return; // Already at the top
    }

    if (historyIndex >= 0 && historyIndex < history.length) {
      buffer.setText(history[historyIndex] ?? "");
      repaint();
      notifyChange();
    }
  }

  function navigateHistoryDown(): void {
    if (historyIndex === -1) {
      return; // Not in history
    }

    if (historyIndex === history.length - 1) {
      // Restore draft
      buffer.setText(draftText ?? "");
      draftText = null;
      historyIndex = -1;
    } else {
      historyIndex += 1;
      buffer.setText(history[historyIndex] ?? "");
    }

    repaint();
    notifyChange();
  }

  function handleReturnKey(ctrl: boolean, alt: boolean, shift: boolean): void {
    const bufferText = buffer.getText();
    const { col } = buffer.getCursor();
    const currentLine = bufferText.split("\n")[buffer.getCursor().line] ?? "";

    let hasTrailingBackslash = false;

    if (col > 0) {
      const lineGraphemes = graphemes(currentLine);
      const beforeCursor = lineGraphemes.slice(0, col).join("");

      if (beforeCursor.endsWith("\\")) {
        hasTrailingBackslash = true;
      }
    }

    if (hasTrailingBackslash && !ctrl && !alt && !shift) {
      buffer.deleteBackward();
      buffer.newline();
      repaint();
      notifyChange();
    } else if ((shift || alt) && !ctrl) {
      buffer.newline();
      repaint();
      notifyChange();
    } else if (!ctrl && !alt && !shift) {
      const message = buffer.expand();

      saveToHistory(message);
      buffer.setText("");
      repaint();
      notifyChange();
      submitCallbacks.forEach((cb) => {
        cb(message);
      });
    }
  }

  function handleCharKey(
    text: string,
    ctrl: boolean,
    alt: boolean,
    shift: boolean
  ): void {
    // Ctrl-C: interrupt the current run
    if (ctrl && text === "c") {
      interruptCallbacks.forEach((cb) => {
        cb();
      });

      return;
    }

    // Ctrl-D on an empty buffer: exit
    if (ctrl && text === "d" && buffer.getText().length === 0) {
      exitCallbacks.forEach((cb) => {
        cb();
      });

      return;
    }

    if (ctrl || alt || shift) {
      const keyParts: string[] = [];

      if (ctrl) {
        keyParts.push("ctrl");
      }

      if (alt) {
        keyParts.push("alt");
      }

      if (shift) {
        keyParts.push("shift");
      }

      keyParts.push(text);
      const normalizedKey = keyParts.join("+");

      const action = keyDispatchTable.get(normalizedKey);

      if (action) {
        action(buffer);
        repaint();
        notifyChange();

        return;
      }
    }

    buffer.insert(text);
    repaint();
    notifyChange();
  }

  function triggerPaletteOrPicker(): void {
    const currentText = buffer.getText();

    if (
      currentText === "/" &&
      openPalette !== undefined &&
      typeof openPalette === "function"
    ) {
      openPalette().catch(() => {
        // ignore errors
      });
    }

    if (
      currentText === "@" &&
      openFilePicker !== undefined &&
      typeof openFilePicker === "function"
    ) {
      openFilePicker().catch(() => {
        // ignore errors
      });
    }
  }

  function dispatchKeyEvent(event: {
    name: string;
    text: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }): void {
    const { name, text, ctrl, alt, shift } = event;

    if (name === "return") {
      handleReturnKey(ctrl, alt, shift);

      return;
    }

    if (name === "char") {
      handleCharKey(text, ctrl, alt, shift);

      return;
    }

    // History navigation: up/down at buffer edges
    if (name === "up") {
      const { line } = buffer.getCursor();

      if (line === 0) {
        navigateHistoryUp();

        return;
      }

      buffer.moveUp();
      repaint();
      notifyChange();

      return;
    }

    if (name === "down") {
      const { line } = buffer.getCursor();
      const lines = buffer.getText().split("\n");
      const lastLine = lines.length - 1;

      if (line === lastLine) {
        navigateHistoryDown();

        return;
      }

      buffer.moveDown();
      repaint();
      notifyChange();

      return;
    }

    const keyParts: string[] = [];

    if (ctrl) {
      keyParts.push("ctrl");
    }

    if (alt) {
      keyParts.push("alt");
    }

    if (shift) {
      keyParts.push("shift");
    }

    keyParts.push(name);
    const normalizedKey = keyParts.join("+");

    const action = keyDispatchTable.get(normalizedKey);

    if (action) {
      action(buffer);
      repaint();
      notifyChange();
    }

    triggerPaletteOrPicker();
  }

  function onDataChunk(raw: string | Buffer): void {
    if (!isOpen) {
      return;
    }

    // Robust against stdin emitting Buffers (when setEncoding wasn't applied):
    // every downstream step (paste scan, key decode) does string ops, so a raw
    // Buffer would throw on the first keystroke. Normalize to a UTF-8 string.
    const chunk = typeof raw === "string" ? raw : raw.toString("utf8");

    debugLog(`[input-chunk] raw=${JSON.stringify(chunk)}`);

    const wasActive = pasteScanner.isActive();
    const pasteScan = pasteScanner.feed(chunk);

    if (pasteScan.content !== null) {
      debugLog(`[paste] content=${JSON.stringify(pasteScan.content)}`);

      buffer.insertPaste(pasteScan.content);
      repaint();
      notifyChange();

      return;
    }

    if (pasteScanner.isActive() || wasActive) {
      return;
    }

    const keyEvents = decodeKeys(chunk);

    debugLog(`[keys] decoded=${JSON.stringify(keyEvents)}`);

    for (const event of keyEvents) {
      dispatchKeyEvent(event);
    }
  }

  // Set up raw mode and enable bracketed paste
  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }

  // Enable bracketed paste
  out("\x1b[?2004h");

  // Enable Kitty keyboard + modifyOtherKeys (gated by env)
  const shouldSkipKitty =
    process.platform === "win32" ||
    (process.env.SSH_CONNECTION ?? "") !== "" ||
    (process.env.SSH_TTY ?? "") !== "" ||
    (process.env.WSL_DISTRO_NAME ?? "") !== "";

  if (!shouldSkipKitty) {
    out("\x1b[>1u"); // Kitty keyboard
    out("\x1b[>4;2m"); // modifyOtherKeys
  }

  // Set stdin encoding and resume
  if (typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }

  if (typeof stdin.resume === "function") {
    stdin.resume();
  }

  // Attach data listener
  dataListener = onDataChunk;
  stdin.on("data", dataListener);

  return {
    onSubmit(cb: (message: string) => void) {
      submitCallbacks.push(cb);
    },

    onChange(cb: () => void) {
      changeCallbacks.push(cb);
    },

    onInterrupt(cb: () => void) {
      interruptCallbacks.push(cb);
    },

    onExit(cb: () => void) {
      exitCallbacks.push(cb);
    },

    getBuffer(): EditorBuffer {
      return buffer;
    },

    close(): void {
      if (!isOpen) {
        return;
      }

      isOpen = false;

      // Remove data listener
      if (stdin.removeListener !== undefined) {
        stdin.removeListener("data", dataListener);
      }

      // Disable bracketed paste
      out("\x1b[?2004l");

      // Disable Kitty + modifyOtherKeys
      if (!shouldSkipKitty) {
        out("\x1b[<u");
        out("\x1b[>4;0m");
      }

      // Unset raw mode
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
    },
  };
}
