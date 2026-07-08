import { appendFileSync } from "node:fs";
import { EditorBuffer } from "./buffer";
import { decodeKeys } from "./keys";
import { createPasteScanner } from "./paste";
import { renderEditor } from "./view";
import { graphemes } from "./segments";
import { trace } from "../lib/trace";
import { createCompletion, type IEditorCompletionSource } from "./completion";

// Re-exported: the host-facing completion-source contract moved to
// editor/completion.ts with the state machine; existing importers keep working.
export type { IEditorCompletionSource } from "./completion";

export interface IEditorHandle {
  onSubmit(cb: (message: string) => void): void;
  onChange(cb: () => void): void;
  onInterrupt(cb: () => void): void;
  onExit(cb: () => void): void;
  /** Shift+Tab — cycle the session mode (plan/normal/…). The host decides what
   *  cycling means; the editor just forwards the keypress. */
  onCycleMode(cb: () => void): void;
  /** ↑/↓ while the input buffer is EMPTY — offer the keypress to the host so it
   *  can navigate an out-of-band overlay (the live agent tree). `delta` is -1 for
   *  up, +1 for down; the callback returns `true` to consume the key, `false` to
   *  let the editor handle it as cursor/history movement. Only consulted on an
   *  empty buffer so it never hijacks arrows while the user is composing. */
  onNavigateTree(cb: (delta: number) => boolean): void;
  getBuffer(): EditorBuffer;
  /** Update the terminal dimensions and repaint. The CLI calls this on a
   *  terminal resize; without it the editor keeps wrapping/windowing at the
   *  dimensions captured when it was created, so after a resize the current
   *  line can be clipped off the (now-shorter) block or wrapped at a stale width. */
  resize(columns: number, rows: number): void;
  /** Detach from stdin so an overlay (file picker / command palette) can own
   *  keypress input without the editor consuming the same chunks. Pair with
   *  resume(). No-op if not open or already suspended. */
  suspend(): void;
  /** Re-attach to stdin after an overlay closes. No-op unless suspended. */
  resume(): void;
  /** Gate input independently of suspend/resume: while inert, the editor ignores
   *  all keystrokes and never repaints, even if resume() runs. Used by self-managed
   *  overlays (e.g. /config) whose launcher may resume the editor underneath them. */
  setInputInert(on: boolean): void;
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
  completion?: IEditorCompletionSource;
  /** Ctrl+V handler: read the system clipboard and return the text to insert at
   *  the cursor (an image capture returns a `[image #N]` chip and registers the
   *  attachment as a side effect; otherwise the clipboard text), or null to insert
   *  nothing. Async because reading the clipboard shells out. Absent ⇒ Ctrl+V is a
   *  no-op (the terminal's own Cmd+V bracketed paste still handles text). */
  pasteFromClipboard?: () => Promise<string | null>;
}

type KeyAction = (buffer: EditorBuffer) => void;

/** Rows the status bar reserves below the editor block: the 2-row bar plus the
 *  prompt/input row. renderEditor must window to the SAME height the StatusBar
 *  can actually paint (rows - this), or the cursor line gets clipped off the
 *  bottom when the buffer is taller than the visible area. Mirrors
 *  RESERVED_ROWS (2) + 1 in status-bar.ts. */
const EDITOR_RESERVED_ROWS = 3;

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
  table.set("escape", (buf) => {
    buf.clear();
  }); // wipe the whole input (Ctrl+Z restores it)

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
    openPalette,
    openFilePicker,
    completion: completionSource,
    pasteFromClipboard,
  } = deps;

  // Mutable so a terminal resize can update them (see the handle's `resize`);
  // renderEditor wraps at `columns` and windows at `rows - EDITOR_RESERVED_ROWS`.
  let columns = deps.columns ?? 80;
  let rows = deps.rows ?? 10;

  const buffer = new EditorBuffer();
  const pasteScanner = createPasteScanner();
  const keyDispatchTable = buildKeyDispatchTable();

  let isOpen = true;
  // True while an async clipboard paste (Ctrl+V) is in flight — drops repeats so a
  // slow (osascript) read can't be triggered concurrently and double-insert.
  let pasting = false;
  // True while an overlay (file picker / command palette) owns stdin: the editor
  // detaches its `data` listener so it doesn't also consume the overlay's keystrokes.
  let suspended = false;
  // True while a self-managed overlay (e.g. /config) owns input. Unlike `suspended`
  // this is NOT cleared by resume(), so the palette's fire-and-forget `runLine` +
  // `finally { resume() }` can't re-activate the editor underneath the overlay
  // (which would echo every keystroke into the input row — double-typed text).
  let inert = false;
  const submitCallbacks: ((message: string) => void)[] = [];
  const changeCallbacks: (() => void)[] = [];
  const interruptCallbacks: (() => void)[] = [];
  const exitCallbacks: (() => void)[] = [];
  const cycleModeCallbacks: (() => void)[] = [];
  const navigateTreeCallbacks: ((delta: number) => boolean)[] = [];

  // Offer an empty-buffer ↑/↓ to the host (live agent tree). Returns true if a
  // callback consumed it, so the editor should skip its own cursor/history move.
  const dispatchNavigateTree = (delta: number): boolean =>
    buffer.getText().length === 0 &&
    navigateTreeCallbacks.some((cb) => cb(delta));

  // In-session history: submitted messages for up/down navigation
  const history: string[] = [];
  let historyIndex = -1; // -1 = not in history, >= 0 = viewing history item
  let draftText: string | null = null;
  let dataListener: ((chunk: string) => void) | null = null;
  // The `@`-mention dropdown state machine (see editor/completion.ts).
  const completion = createCompletion({
    buffer,
    source: completionSource,
    repaint: () => {
      repaint();
    },
    notifyChange: () => {
      notifyChange();
    },
  });

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
        maxRows: Math.max(1, rows - EDITOR_RESERVED_ROWS),
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

    // Ctrl-V: paste from the system clipboard (image → [image #N] chip + attachment,
    // else clipboard text). Async — insert on resolve, like openPalette. Without a
    // handler, swallow the key (don't insert a literal "v"). The `pasting` latch
    // drops repeat Ctrl+V while a read is in flight: the clipboard read can take
    // ~1s (osascript), so key-repeat/spam would otherwise fire concurrent reads and
    // double-insert.
    if (ctrl && text === "v") {
      if (pasteFromClipboard !== undefined && !pasting) {
        pasting = true;
        pasteFromClipboard()
          .then((insert) => {
            // The read is async (~1s); the editor may have been closed meanwhile.
            // Mutating/repainting after close() (raw mode + bracketed paste already
            // torn down) would corrupt output — drop the result if we're gone.
            if (isOpen && insert !== null && insert.length > 0) {
              buffer.insert(insert);
              repaint();
              notifyChange();
            }
          })
          .catch((err: unknown) => {
            trace("editor.paste", err);
          })
          .finally(() => {
            pasting = false;
          });
      }

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

    if (completion.isOpen()) {
      completion.refresh();
    } else {
      triggerPaletteOrPicker();
    }
  }

  function triggerPaletteOrPicker(): void {
    const currentText = buffer.getText();

    // `/` as the sole character opens the command palette (a slash command).
    if (currentText === "/" && typeof openPalette === "function") {
      openPalette().catch((err: unknown) => {
        trace("editor.palette", err);
      });

      return;
    }

    // `@` typed at a word boundary (start of line or after whitespace) opens the
    // completion dropdown. Reading buffer state means it fires only on the `@`
    // keypress itself, not when backspace/motion happens to land after an `@`.
    const { line, col } = buffer.getCursor();
    const lineText = currentText.split("\n")[line] ?? "";
    const at = lineText[col - 1];
    const before = lineText[col - 2];

    if (at !== "@" || !(before === undefined || /\s/u.test(before))) {
      return;
    }

    if (completionSource !== undefined) {
      completion.open();
    } else if (typeof openFilePicker === "function") {
      openFilePicker().catch((err: unknown) => {
        trace("editor.picker", err);
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

    // The open dropdown intercepts navigation/accept/cancel; printable chars and
    // backspace fall through to normal editing, then refreshCompletion() re-queries.
    if (completion.handleKey(name)) {
      return;
    }

    // Shift+Tab cycles the session mode — a global action, not text editing.
    if (name === "backtab") {
      cycleModeCallbacks.forEach((cb) => {
        cb();
      });

      return;
    }

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
      // Empty buffer: let the host navigate the agent tree (if one is live).
      if (dispatchNavigateTree(-1)) {
        return;
      }

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
      if (dispatchNavigateTree(1)) {
        return;
      }

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

      // Backspace/delete change the query; re-query (or close if the `@` is gone).
      if (completion.isOpen()) {
        completion.refresh();
      }
    }
  }

  function onDataChunk(raw: string | Buffer): void {
    // Ignore input while closed, suspended, or gated inert by a self-managed
    // overlay — otherwise the editor echoes keys into its input row on top of the
    // overlay's own render (the /config double-typed-text bug).
    if (!isOpen || suspended || inert) {
      return;
    }

    // Robust against stdin emitting Buffers (when setEncoding wasn't applied):
    // every downstream step (paste scan, key decode) does string ops, so a raw
    // Buffer would throw on the first keystroke. Normalize to a UTF-8 string.
    const chunk = typeof raw === "string" ? raw : raw.toString("utf8");

    debugLog(`[input-chunk] raw=${JSON.stringify(chunk)}`);
    processChunk(chunk);
  }

  /** Feed one chunk through the paste scanner then the key decoder. A completed
   *  paste may leave trailing bytes in the SAME chunk (coalesced keystrokes, or a
   *  second paste) — process that remainder recursively so nothing is dropped. */
  function processChunk(chunk: string): void {
    const wasActive = pasteScanner.isActive();
    const pasteScan = pasteScanner.feed(chunk);

    if (pasteScan.content !== null) {
      debugLog(`[paste] content=${JSON.stringify(pasteScan.content)}`);

      buffer.insertPaste(pasteScan.content);
      repaint();
      notifyChange();

      if (pasteScan.remainder.length > 0) {
        processChunk(pasteScan.remainder);
      }

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

    onCycleMode(cb: () => void) {
      cycleModeCallbacks.push(cb);
    },

    onNavigateTree(cb: (delta: number) => boolean) {
      navigateTreeCallbacks.push(cb);
    },

    getBuffer(): EditorBuffer {
      return buffer;
    },

    resize(nextColumns: number, nextRows: number): void {
      const targetColumns = nextColumns > 0 ? nextColumns : columns;
      const targetRows = nextRows > 0 ? nextRows : rows;

      // Only repaint when the size actually changed — some terminals emit
      // duplicate/high-frequency resize events, and a no-op repaint flickers.
      if (targetColumns !== columns || targetRows !== rows) {
        columns = targetColumns;
        rows = targetRows;
        repaint();
      }
    },

    suspend(): void {
      if (!isOpen || suspended) {
        return;
      }

      suspended = true;

      if (stdin.removeListener !== undefined) {
        stdin.removeListener("data", dataListener);
      }
    },

    resume(): void {
      if (!isOpen || !suspended) {
        return;
      }

      suspended = false;
      stdin.on("data", dataListener);
    },

    setInputInert(on: boolean): void {
      inert = on;
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
