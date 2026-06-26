import { graphemes } from "./segments";

export class EditorBuffer {
  private lines: string[];
  private cursorLine: number;
  private cursorCol: number; // grapheme offset within lines[cursorLine]

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

  insert(text: string): void {
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

  newline(): void {
    const g = this.curG();
    const left = g.slice(0, this.cursorCol).join("");
    const right = g.slice(this.cursorCol).join("");

    this.lines.splice(this.cursorLine, 1, left, right);
    this.cursorLine += 1;
    this.cursorCol = 0;
  }

  deleteBackward(): void {
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
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
    } else if (this.cursorLine > 0) {
      this.cursorLine -= 1;
      this.cursorCol = this.curG().length;
    }
  }

  moveRight(): void {
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
}
