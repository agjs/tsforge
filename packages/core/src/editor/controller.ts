import { EditorBuffer } from "./buffer";
import { decodeKeys } from "./keys";
import { createPasteScanner } from "./paste";
import { renderEditor } from "./view";

export interface IEditorHandle {
  onSubmit(cb: (message: string) => void): void;
  onChange(cb: () => void): void;
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
  columns?: number;
  rows?: number;
  openPalette?: () => Promise<void>;
  openFilePicker?: () => Promise<void>;
}

type KeyAction = (buffer: EditorBuffer) => void;

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

  // Motion keys
  table.set("left", (buf) => {
    buf.moveLeft();
  });
  table.set("right", (buf) => {
    buf.moveRight();
  });
  table.set("up", (buf) => {
    buf.moveUp();
  });
  table.set("down", (buf) => {
    buf.moveDown();
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

    out(frame.frame);
  }

  function notifyChange(): void {
    changeCallbacks.forEach((cb) => {
      cb();
    });
  }

  function handleReturnKey(ctrl: boolean, alt: boolean, shift: boolean): void {
    const bufferText = buffer.getText();
    const { col } = buffer.getCursor();
    const currentLine = bufferText.split("\n")[buffer.getCursor().line] ?? "";

    let hasTrailingBackslash = false;

    if (col > 0) {
      const beforeCursor = currentLine.substring(0, col);

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

  function onDataChunk(chunk: string): void {
    if (!isOpen) {
      return;
    }

    const wasActive = pasteScanner.isActive();
    const pasteScan = pasteScanner.feed(chunk);

    if (pasteScan.content !== null) {
      buffer.insertPaste(pasteScan.content);
      repaint();
      notifyChange();

      return;
    }

    if (pasteScanner.isActive() || wasActive) {
      return;
    }

    const keyEvents = decodeKeys(chunk);

    for (const event of keyEvents) {
      const { name, text, ctrl, alt, shift } = event;

      if (name === "return") {
        handleReturnKey(ctrl, alt, shift);
        continue;
      }

      if (name === "char") {
        handleCharKey(text, ctrl, alt, shift);
        continue;
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
