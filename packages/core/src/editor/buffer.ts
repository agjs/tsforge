import { graphemes } from "./segments";
import { KillRing } from "./kill-ring";
import { UndoStack, type ISnapshot } from "./undo-stack";

export class EditorBuffer {
  private lines: string[];

  private cursorLine: number;

  private cursorCol: number; // grapheme offset within lines[cursorLine]

  private stickyCol: number | null = null;

  private killRing: KillRing = new KillRing();

  private lastWasKill = false;

  private lastYank: { start: number; length: number } | null = null;

  private undoStack: UndoStack = new UndoStack();

  private lastSnapshotKind: string | null = null;

  private pastes: Map<number, string> = new Map<number, string>();

  private pasteCounter = 0;

  constructor(initial = "") {
    this.lines = initial.split("\n");
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = graphemes(this.lines[this.cursorLine] ?? "").length;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  getCursor(): { line: number; col: number } {
    return { line: this.cursorLine, col: this.cursorCol };
  }

  private curG(): string[] {
    return graphemes(this.lines[this.cursorLine] ?? "");
  }

  private clearSticky(): void {
    this.stickyCol = null;
  }

  private snapshot(): ISnapshot {
    return {
      lines: structuredClone(this.lines),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
    };
  }

  private maybeSnapshot(kind: string): void {
    if (kind !== this.lastSnapshotKind) {
      this.undoStack.push(this.snapshot());
      this.lastSnapshotKind = kind;
    }
  }

  private insertRaw(text: string): void {
    // Pure mutation: splice graphemes and advance cursor, no snapshot.
    // text has no newlines here (newline() handles those); split defensively.
    const parts = text.split("\n");

    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        this.newline();
      }

      const piece = parts[i] ?? "";
      const g = this.curG();

      g.splice(this.cursorCol, 0, ...graphemes(piece));
      this.lines[this.cursorLine] = g.join("");
      this.cursorCol += graphemes(piece).length;
    }
  }

  insert(text: string): void {
    this.clearSticky();
    const kind = text.trim().length === 0 ? "insert-space" : "insert-word";

    this.maybeSnapshot(kind);
    this.insertRaw(text);
  }

  insertPaste(text: string): void {
    const lineCount = text.split("\n").length;
    const charCount = text.length;

    if (lineCount > 10 || charCount > 1000) {
      this.pasteCounter += 1;
      const id = this.pasteCounter;

      this.pastes.set(id, text);
      this.insert(`[paste #${id} +${lineCount} lines]`);
    } else {
      this.insert(text);
    }
  }

  newline(): void {
    this.clearSticky();

    this.maybeSnapshot("other");
    const g = this.curG();
    const left = g.slice(0, this.cursorCol).join("");
    const right = g.slice(this.cursorCol).join("");

    this.lines.splice(this.cursorLine, 1, left, right);
    this.cursorLine += 1;
    this.cursorCol = 0;
  }

  deleteBackward(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");

    if (this.cursorCol > 0) {
      const g = this.curG();

      g.splice(this.cursorCol - 1, 1);
      this.lines[this.cursorLine] = g.join("");
      this.cursorCol -= 1;

      return;
    }

    if (this.cursorLine === 0) {
      return;
    }

    const prev = graphemes(this.lines[this.cursorLine - 1] ?? "");
    const cur = this.lines[this.cursorLine] ?? "";

    this.cursorCol = prev.length;
    this.lines.splice(
      this.cursorLine - 1,
      2,
      (this.lines[this.cursorLine - 1] ?? "") + cur
    );
    this.cursorLine -= 1;
  }

  deleteForward(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");
    const g = this.curG();

    if (this.cursorCol < g.length) {
      g.splice(this.cursorCol, 1);
      this.lines[this.cursorLine] = g.join("");

      return;
    }

    if (this.cursorLine >= this.lines.length - 1) {
      return;
    }

    const next = this.lines[this.cursorLine + 1] ?? "";

    this.lines.splice(
      this.cursorLine,
      2,
      (this.lines[this.cursorLine] ?? "") + next
    );
  }

  moveLeft(): void {
    this.clearSticky();

    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
    } else if (this.cursorLine > 0) {
      this.cursorLine -= 1;
      this.cursorCol = this.curG().length;
    }
  }

  moveRight(): void {
    this.clearSticky();

    if (this.cursorCol < this.curG().length) {
      this.cursorCol += 1;
    } else if (this.cursorLine < this.lines.length - 1) {
      this.cursorLine += 1;
      this.cursorCol = 0;
    }
  }

  setText(text: string, cursorToEnd = true): void {
    this.lines = text.split("\n");

    if (cursorToEnd) {
      this.cursorLine = this.lines.length - 1;
      this.cursorCol = graphemes(this.lines[this.cursorLine] ?? "").length;
    } else {
      this.cursorLine = 0;
      this.cursorCol = 0;
    }
  }

  private isWordChar(ch: string): boolean {
    return ch.trim().length > 0;
  }

  moveWordRight(): void {
    this.clearSticky();
    const g = this.curG();
    let i = this.cursorCol;

    while (i < g.length && !this.isWordChar(g[i] ?? "")) {
      i += 1;
    }

    while (i < g.length && this.isWordChar(g[i] ?? "")) {
      i += 1;
    }

    this.cursorCol = i;
  }

  moveWordLeft(): void {
    this.clearSticky();
    const g = this.curG();
    let i = this.cursorCol;

    while (i > 0 && !this.isWordChar(g[i - 1] ?? "")) {
      i -= 1;
    }

    while (i > 0 && this.isWordChar(g[i - 1] ?? "")) {
      i -= 1;
    }

    this.cursorCol = i;
  }

  moveLineStart(): void {
    this.clearSticky();
    this.cursorCol = 0;
  }

  moveLineEnd(): void {
    this.clearSticky();
    this.cursorCol = this.curG().length;
  }

  moveDocStart(): void {
    this.clearSticky();
    this.cursorLine = 0;
    this.cursorCol = 0;
  }

  moveDocEnd(): void {
    this.clearSticky();
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = this.curG().length;
  }

  private vertical(delta: number): void {
    const target = this.cursorLine + delta;

    if (target < 0 || target >= this.lines.length) {
      return;
    }

    this.stickyCol ??= this.cursorCol;
    this.cursorLine = target;
    this.cursorCol = Math.min(
      this.stickyCol,
      graphemes(this.lines[target] ?? "").length
    );
  }

  moveUp(): void {
    this.vertical(-1);
  }

  moveDown(): void {
    this.vertical(1);
  }

  deleteWordBackward(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");

    const g = this.curG();
    let start = this.cursorCol;

    while (start > 0 && !this.isWordChar(g[start - 1] ?? "")) {
      start -= 1;
    }

    while (start > 0 && this.isWordChar(g[start - 1] ?? "")) {
      start -= 1;
    }

    const removed = g.slice(start, this.cursorCol).join("");

    g.splice(start, this.cursorCol - start);
    this.lines[this.cursorLine] = g.join("");
    this.cursorCol = start;

    this.killRing.push(removed, { accumulate: this.lastWasKill });
    this.lastWasKill = true;
  }

  deleteWordForward(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");

    const g = this.curG();
    let end = this.cursorCol;

    while (end < g.length && !this.isWordChar(g[end] ?? "")) {
      end += 1;
    }

    while (end < g.length && this.isWordChar(g[end] ?? "")) {
      end += 1;
    }

    const removed = g.slice(this.cursorCol, end).join("");

    g.splice(this.cursorCol, end - this.cursorCol);
    this.lines[this.cursorLine] = g.join("");

    this.killRing.push(removed, { accumulate: this.lastWasKill });
    this.lastWasKill = true;
  }

  deleteToLineStart(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");

    const g = this.curG();
    const removed = g.slice(0, this.cursorCol).join("");

    g.splice(0, this.cursorCol);
    this.lines[this.cursorLine] = g.join("");
    this.cursorCol = 0;

    this.killRing.push(removed, { accumulate: this.lastWasKill });
    this.lastWasKill = true;
  }

  deleteToLineEnd(): void {
    this.clearSticky();
    this.maybeSnapshot("delete");

    const g = this.curG();
    const removed = g.slice(this.cursorCol).join("");

    g.splice(this.cursorCol);
    this.lines[this.cursorLine] = g.join("");

    this.killRing.push(removed, { accumulate: this.lastWasKill });
    this.lastWasKill = true;
  }

  yank(): void {
    this.clearSticky();
    this.maybeSnapshot("other");

    const text = this.killRing.current();
    const startCol = this.cursorCol;

    this.insertRaw(text);
    this.lastYank = { start: startCol, length: graphemes(text).length };
    this.lastWasKill = false;
  }

  yankPop(): void {
    this.clearSticky();

    if (this.lastYank === null) {
      return;
    }

    this.maybeSnapshot("other");
    this.killRing.rotate();
    const text = this.killRing.current();
    const g = this.curG();
    const oldLength = this.lastYank.length;
    const startCol = this.lastYank.start;

    g.splice(startCol, oldLength, ...graphemes(text));
    this.lines[this.cursorLine] = g.join("");
    this.cursorCol = startCol + graphemes(text).length;
    this.lastYank = { start: startCol, length: graphemes(text).length };
  }

  undo(): void {
    const snapshot = this.undoStack.undo(this.snapshot());

    if (snapshot) {
      this.lines = snapshot.lines;
      this.cursorLine = snapshot.cursorLine;
      this.cursorCol = snapshot.cursorCol;
      this.lastSnapshotKind = null;
    }
  }

  redo(): void {
    const snapshot = this.undoStack.redo();

    if (snapshot) {
      this.lines = snapshot.lines;
      this.cursorLine = snapshot.cursorLine;
      this.cursorCol = snapshot.cursorCol;
      this.lastSnapshotKind = null;
    }
  }

  expand(): string {
    return this.getText().replace(
      /\[paste #(\d+) \+\d+ lines\]/g,
      (_, id) => this.pastes.get(Number(id)) ?? _
    );
  }
}
