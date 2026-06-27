# Multi-line Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Node `readline` for tsforge's interactive prompt with a grapheme-aware multi-line editor: Enter submits, Shift/Alt+Enter (and `\`+Enter) insert a newline, paste lands in the buffer and never auto-submits.

**Architecture:** A pure core (`EditorBuffer` text model, `KeyDecoder`, `PasteScanner`, `EditorView` renderer) driven by an I/O glue layer (`EditorController`) that owns stdin in raw mode and repaints via the existing `statusBar`. `cli.ts` consumes controller events instead of `rl.on("line")`. `TSFORGE_BASIC_INPUT=1` keeps the readline path as a fallback.

**Tech Stack:** TypeScript on Bun, `Intl.Segmenter` for graphemes, existing `render/status-bar.ts` scroll-region painting, `bun:test` + FakeTerm frame tests (no PTY — node-pty doesn't work under Bun).

## Global Constraints

- House rules: no `as` casts, no `eslint-disable`, cyclomatic complexity ≤ 20, prefer shared AST/segmentation helpers; run full `bun run validate` before "done".
- Pure modules (`buffer`, `keys`, `paste`, `view`) do NO I/O and emit NO ANSI except `view`.
- Grapheme-correct everywhere: cursor indices are grapheme offsets, segmented via a single shared `Intl.Segmenter` helper.
- Enter (`\r`, no modifiers) submits; Shift+Enter, Alt+Enter (`\x1b\r`), and a trailing `\`+Enter insert a newline.
- Bracketed paste markers: start `\x1b[200~`, end `\x1b[201~`. Large paste = `> 10` lines OR `> 1000` chars → `[paste #N +M lines]`.
- The editor is a TTY feature; non-TTY/pipe input and `TSFORGE_BASIC_INPUT=1` keep the current readline path verbatim.
- File layout under `packages/core/src/editor/`; tests under `packages/core/tests/editor-*.test.ts`.

---

### Task 1: EditorBuffer — text model core (insert, newline, delete, char cursor)

**Files:**
- Create: `packages/core/src/editor/segments.ts` (shared grapheme helper)
- Create: `packages/core/src/editor/buffer.ts`
- Test: `packages/core/tests/editor-buffer.test.ts`

**Interfaces:**
- Produces:
  - `segments.ts`: `export function graphemes(s: string): string[]` (split into grapheme clusters), `export function graphemeCount(s: string): number`.
  - `buffer.ts`: `export class EditorBuffer { constructor(initial?: string); getText(): string; getCursor(): { line: number; col: number }; insert(text: string): void; newline(): void; deleteBackward(): void; deleteForward(): void; moveLeft(): void; moveRight(): void; setText(text: string, cursorToEnd?: boolean): void; }`. Internally `lines: string[]`, `cursorLine`, `cursorCol` (grapheme offset within the line).

- [ ] **Step 1: Write failing tests for insert / newline / char delete / char moves**

```ts
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
  b.moveLeft(); b.moveLeft(); // from end → col 0 of line 1
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
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test packages/core/tests/editor-buffer.test.ts`
Expected: FAIL (module not found / EditorBuffer undefined).

- [ ] **Step 3: Implement `segments.ts` then `buffer.ts`**

```ts
// segments.ts
const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEG.segment(s)) {
    out.push(segment);
  }
  return out;
}
export function graphemeCount(s: string): number {
  return graphemes(s).length;
}
```

```ts
// buffer.ts — core only (later tasks extend this class in the same file)
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
    this.lines.splice(this.cursorLine - 1, 2, (this.lines[this.cursorLine - 1] ?? "") + cur);
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
    this.lines.splice(this.cursorLine, 2, (this.lines[this.cursorLine] ?? "") + next);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/core/tests/editor-buffer.test.ts`
Expected: PASS (4 tests). Fix the test that places the cursor if the helper moves differ; assertions define the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/editor/segments.ts packages/core/src/editor/buffer.ts packages/core/tests/editor-buffer.test.ts
git commit -m "feat(editor): EditorBuffer core text model (grapheme-aware insert/newline/delete/move)"
```

---

### Task 2: EditorBuffer — word/line/document navigation + sticky-column vertical moves

**Files:**
- Modify: `packages/core/src/editor/buffer.ts`
- Test: `packages/core/tests/editor-buffer.test.ts` (append)

**Interfaces:**
- Produces (added to `EditorBuffer`): `moveWordLeft(): void; moveWordRight(): void; moveLineStart(): void; moveLineEnd(): void; moveDocStart(): void; moveDocEnd(): void; moveUp(): void; moveDown(): void;`. `moveUp/Down` keep a private `stickyCol` so vertical moves through short lines preserve the desired column.

- [ ] **Step 1: Write failing tests**

```ts
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
```

- [ ] **Step 2: Run → FAIL** (`bun test packages/core/tests/editor-buffer.test.ts`).

- [ ] **Step 3: Implement.** Word boundary = transition between whitespace and non-whitespace over the grapheme array. `moveWordRight`: from `cursorCol`, skip non-word then word (or the reverse depending on standard — match the test: stop at end of the next word). `moveUp/Down`: set `stickyCol` on horizontal moves to `null`; on first vertical move capture `stickyCol = cursorCol`; clamp `cursorCol = min(stickyCol, len(targetLine))`. Reset `stickyCol` to `null` in every horizontal/edit op.

```ts
// add fields + reset helper
private stickyCol: number | null = null;
private clearSticky(): void { this.stickyCol = null; }
// call this.clearSticky() at the top of insert/newline/delete*/moveLeft/moveRight/moveWord*/moveLineStart/End/DocStart/End

private isWordChar(ch: string): boolean {
  return ch.trim().length > 0;
}

moveWordRight(): void {
  this.clearSticky();
  const g = this.curG();
  let i = this.cursorCol;
  while (i < g.length && !this.isWordChar(g[i] ?? "")) i += 1;
  while (i < g.length && this.isWordChar(g[i] ?? "")) i += 1;
  this.cursorCol = i;
}

moveWordLeft(): void {
  this.clearSticky();
  const g = this.curG();
  let i = this.cursorCol;
  while (i > 0 && !this.isWordChar(g[i - 1] ?? "")) i -= 1;
  while (i > 0 && this.isWordChar(g[i - 1] ?? "")) i -= 1;
  this.cursorCol = i;
}

moveLineStart(): void { this.clearSticky(); this.cursorCol = 0; }
moveLineEnd(): void { this.clearSticky(); this.cursorCol = this.curG().length; }
moveDocStart(): void { this.clearSticky(); this.cursorLine = 0; this.cursorCol = 0; }
moveDocEnd(): void {
  this.clearSticky();
  this.cursorLine = this.lines.length - 1;
  this.cursorCol = this.curG().length;
}

private vertical(delta: number): void {
  const target = this.cursorLine + delta;
  if (target < 0 || target >= this.lines.length) return;
  if (this.stickyCol === null) this.stickyCol = this.cursorCol;
  this.cursorLine = target;
  this.cursorCol = Math.min(this.stickyCol, graphemes(this.lines[target] ?? "").length);
}
moveUp(): void { this.vertical(-1); }
moveDown(): void { this.vertical(1); }
```

- [ ] **Step 4: Run → PASS.** Adjust word-move tests if the boundary convention differs; lock the convention with the assertions.

- [ ] **Step 5: Commit** `feat(editor): word/line/doc navigation + sticky-column vertical moves`.

---

### Task 3: EditorBuffer — kill-ring + region deletes (word, line, to-edge)

**Files:**
- Create: `packages/core/src/editor/kill-ring.ts`
- Modify: `packages/core/src/editor/buffer.ts`
- Test: `packages/core/tests/editor-buffer.test.ts` (append)

**Interfaces:**
- Produces: `kill-ring.ts`: `export class KillRing { push(text: string, opts?: { prepend?: boolean; accumulate?: boolean }): void; current(): string; rotate(): void; }`. `EditorBuffer` gains `deleteWordBackward(): void; deleteWordForward(): void; deleteToLineStart(): void; deleteToLineEnd(): void; yank(): void; yankPop(): void;` (the delete ops push removed text to a `KillRing` instance held by the buffer).

- [ ] **Step 1: Write failing tests**

```ts
test("Ctrl-K (deleteToLineEnd) then yank round-trips", () => {
  const b = new EditorBuffer("hello world");
  b.moveLineStart(); b.moveWordRight(); // col 5 (after hello)
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
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `KillRing` (array + index; `push` with prepend/accumulate merges into entry 0 when the last action was also a kill — track via a buffer-level `lastWasKill` flag) and the delete ops (compute the removed grapheme range, store it via `this.killRing.push(removed, …)`, splice it out, move cursor to the cut start). `yank()` inserts `killRing.current()`; `yankPop()` calls `rotate()` then replaces the just-yanked span (track `lastYank` start/length).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): kill-ring + word/line/to-edge deletes with yank/yank-pop`.

---

### Task 4: EditorBuffer — undo/redo with word-coalescing

**Files:**
- Create: `packages/core/src/editor/undo-stack.ts`
- Modify: `packages/core/src/editor/buffer.ts`
- Test: `packages/core/tests/editor-buffer.test.ts` (append)

**Interfaces:**
- Produces: `undo-stack.ts`: `export interface ISnapshot { lines: string[]; cursorLine: number; cursorCol: number } export class UndoStack { push(s: ISnapshot): void; undo(cur: ISnapshot): ISnapshot | null; redo(): ISnapshot | null; }`. `EditorBuffer` gains `undo(): void; redo(): void;` and snapshots before edits, coalescing consecutive word-character inserts into one undo unit (snapshot taken when an edit follows a non-edit or a word boundary).

- [ ] **Step 1: Write failing tests**

```ts
test("undo reverts a word as one unit, redo restores it", () => {
  const b = new EditorBuffer();
  b.insert("h"); b.insert("i"); // coalesced
  b.undo();
  expect(b.getText()).toBe("");
  b.redo();
  expect(b.getText()).toBe("hi");
});

test("space then word are separate undo units", () => {
  const b = new EditorBuffer();
  b.insert("a"); b.insert(" "); b.insert("b");
  b.undo();
  expect(b.getText()).toBe("a ");
  b.undo();
  expect(b.getText()).toBe("a");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `snapshot()` deep-copies state (`structuredClone`). Before each mutating op, call `maybeSnapshot(kind)`: push a snapshot when `kind` differs from the last (`insert-word` vs `insert-space` vs `delete` vs `other`); clear the redo stack on a fresh edit. `undo()` pushes current onto redo and restores the popped snapshot; `redo()` reverses.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): coalesced undo/redo`.

---

### Task 5: EditorBuffer — large-paste markers + expand

**Files:**
- Modify: `packages/core/src/editor/buffer.ts`
- Test: `packages/core/tests/editor-buffer.test.ts` (append)

**Interfaces:**
- Produces (added to `EditorBuffer`): `insertPaste(text: string): void` (inserts text directly if small; else inserts a `[paste #N +M lines]` marker grapheme-run and stashes the real text), `expand(): string` (returns `getText()` with every marker replaced by its stashed text — used at submit). A private `pastes: Map<number, string>` + counter.

- [ ] **Step 1: Write failing tests**

```ts
test("small paste inserts literally", () => {
  const b = new EditorBuffer();
  b.insertPaste("one\ntwo");
  expect(b.getText()).toBe("one\ntwo");
  expect(b.expand()).toBe("one\ntwo");
});

test("large paste shows a marker but expands on submit", () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const b = new EditorBuffer();
  b.insertPaste(big);
  expect(b.getText()).toContain("[paste #1 +40 lines]");
  expect(b.getText()).not.toContain("line 39");
  expect(b.expand()).toBe(big);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `insertPaste`: if `lines>10 || chars>1000`, `id = ++counter; pastes.set(id, text); this.insert("[paste #"+id+" +"+lineCount+" lines]")`; else `this.insert(text)`. `expand()`: `getText().replace(/\[paste #(\d+) \+\d+ lines\]/g, (m, id) => this.pastes.get(Number(id)) ?? m)`. (Marker atomicity in cursor/wrap is a v2 refinement; for v1 the marker is ordinary text that simply must round-trip through `expand`.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): large-paste markers with expand-on-submit`.

---

### Task 6: KeyDecoder — raw bytes → normalized key events

**Files:**
- Create: `packages/core/src/editor/keys.ts`
- Test: `packages/core/tests/editor-keys.test.ts`

**Interfaces:**
- Produces: `export interface IKeyEvent { name: string; ctrl: boolean; alt: boolean; shift: boolean; text: string } export function decodeKeys(chunk: string): IKeyEvent[]`. `name` is a stable token: `"return"`, `"backspace"`, `"left"/"right"/"up"/"down"`, `"home"/"end"`, `"delete"`, `"char"` (printable, with `text`), `"escape"`, `"tab"`. Modifiers from Kitty CSI-u / xterm modifyOtherKeys / legacy. The decoder leaves bracketed-paste markers to `PasteScanner` (it skips bytes between `\x1b[200~`/`\x1b[201~` — the controller routes those separately, so `decodeKeys` is only ever fed non-paste bytes).

- [ ] **Step 1: Write failing tests** (the decisive ones: Enter variants)

```ts
import { decodeKeys } from "../src/editor/keys";

test("plain CR is submit (return, no mods)", () => {
  const [k] = decodeKeys("\r");
  expect({ name: k.name, shift: k.shift, alt: k.alt }).toEqual({ name: "return", shift: false, alt: false });
});

test("Alt+Enter decodes as return+alt", () => {
  const [k] = decodeKeys("\x1b\r");
  expect({ name: k.name, alt: k.alt }).toEqual({ name: "return", alt: true });
});

test("Kitty Shift+Enter (CSI 13;2u) decodes as return+shift", () => {
  const [k] = decodeKeys("\x1b[13;2u");
  expect({ name: k.name, shift: k.shift }).toEqual({ name: "return", shift: true });
});

test("xterm modifyOtherKeys Shift+Enter (CSI 27;2;13~) decodes as return+shift", () => {
  const [k] = decodeKeys("\x1b[27;2;13~");
  expect({ name: k.name, shift: k.shift }).toEqual({ name: "return", shift: true });
});

test("Ctrl+W decodes from byte 0x17", () => {
  const [k] = decodeKeys("\x17");
  expect({ name: k.name, ctrl: k.ctrl }).toEqual({ name: "char", ctrl: true });
  expect(k.text).toBe("w");
});

test("printable char and arrow", () => {
  expect(decodeKeys("a")[0]).toMatchObject({ name: "char", text: "a" });
  expect(decodeKeys("\x1b[D")[0]).toMatchObject({ name: "left" });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** a scanning decoder. Order: try CSI-u (`/^\x1b\[(\d+)(?::\d+)*;(\d+)(?::\d+)*u/`) → codepoint+modifier (modifier bitmask: 1=base, then `(mod-1)` bits: 1=shift,2=alt,4=ctrl); xterm modifyOtherKeys (`/^\x1b\[27;(\d+);(\d+)~/`); legacy arrows/home/end (`\x1b[A..` etc.); `\x1b\r`/`\x1b\n` → return+alt; bare `\r`/`\n` → return; `\x7f`/`\b` → backspace; control bytes `0x01..0x1a` → `{name:"char",ctrl:true,text:String.fromCharCode(code+96)}`; `\x1b`+printable → alt+char; else printable runs → `char` events per grapheme. Map codepoint 13 → `return`, 9 → `tab`, 27 → `escape`. cc per branch stays small via a helper table.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): key decoder (Kitty CSI-u + modifyOtherKeys + legacy, Enter variants)`.

---

### Task 7: PasteScanner — finalize (timeout valve + CSI-u-in-paste + tests)

**Files:**
- Modify: `packages/core/src/editor/paste.ts` (already drafted)
- Test: `packages/core/tests/editor-paste.test.ts`

**Interfaces:**
- Keep `createPasteScanner(): IPasteScanner` with `feed(chunk): { content: string | null; active: boolean }` and `isActive()`. Add: inside `feed`, when finalizing content, decode tmux CSI-u control bytes (`/\x1b\[(\d+);\d+u/g` → `String.fromCharCode(cp)`), strip non-printables except `\n`. Add `forceEnd(): string | null` for the controller's 2s timeout valve (returns + clears any open buffer).

- [ ] **Step 1: Write failing tests using the REAL captured bytes**

```ts
import { createPasteScanner } from "../src/editor/paste";

test("extracts a real bracketed paste, CR→\\n, no markers", () => {
  const s = createPasteScanner();
  const chunk = "\x1b[200~line one\rline two\rlast\x1b[201~";
  const r = s.feed(chunk);
  expect(r.content).toBe("line one\nline two\nlast");
  expect(s.isActive()).toBe(false);
});

test("paste split across chunks stays active until the end marker", () => {
  const s = createPasteScanner();
  expect(s.feed("\x1b[200~part1\r").active).toBe(true);
  expect(s.feed("part2").content).toBeNull();
  expect(s.feed("\x1b[201~").content).toBe("part1\npart2");
});

test("forceEnd flushes an unterminated paste (timeout valve)", () => {
  const s = createPasteScanner();
  s.feed("\x1b[200~stuck text");
  expect(s.forceEnd()).toBe("stuck text");
  expect(s.isActive()).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL** on the new behavior (`forceEnd`, CSI-u decode).

- [ ] **Step 3: Implement** the additions in `paste.ts` (keep the existing `feed` structure; add `forceEnd`, the CSI-u decode + non-printable strip in `normalizeNewlines`'s caller).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): finalize PasteScanner (timeout valve + tmux CSI-u decode)`.

---

### Task 8: EditorView — pure ANSI frame renderer

**Files:**
- Create: `packages/core/src/editor/view.ts`
- Test: `packages/core/tests/editor-view.test.ts`

**Interfaces:**
- Produces: `export function renderEditor(input: { lines: string[]; cursorLine: number; cursorCol: number }, opts: { columns: number; maxRows: number; color: boolean }): { frame: string; rows: number; cursorRow: number; cursorCol: number }`. Word-wraps each logical line to `columns`, clips to `maxRows` with `↑ N more`/`↓ N more` indicators centered on the cursor, returns the ANSI block plus the on-screen cursor coordinates. Single logical line ⇒ one visual row (parity with today's `buildInputFrame`).

- [ ] **Step 1: Write failing FakeTerm-style tests** (assert on the returned string/coords, no PTY)

```ts
import { renderEditor } from "../src/editor/view";

test("single line renders one row with the gutter", () => {
  const r = renderEditor({ lines: ["hello"], cursorLine: 0, cursorCol: 5 }, { columns: 40, maxRows: 6, color: false });
  expect(r.rows).toBe(1);
  expect(r.frame).toContain("hello");
  expect(r.cursorRow).toBe(0);
});

test("a long line wraps to multiple visual rows", () => {
  const long = "x".repeat(50);
  const r = renderEditor({ lines: [long], cursorLine: 0, cursorCol: 50 }, { columns: 20, maxRows: 6, color: false });
  expect(r.rows).toBeGreaterThan(1);
});

test("buffer taller than maxRows clips with a scroll indicator", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const r = renderEditor({ lines, cursorLine: 19, cursorCol: 0 }, { columns: 40, maxRows: 6, color: false });
  expect(r.rows).toBeLessThanOrEqual(6);
  expect(r.frame).toContain("more");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** word-wrap (reuse the wrapping idea from `status-bar`'s `clipInput`, generalized to multiple rows), the visible-window computation around the cursor, and ANSI assembly mirroring `buildInputFrame`'s escape conventions (no raw newlines that break the scroll region — position each row explicitly).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): EditorView multi-line renderer (wrap + scroll + cursor)`.

---

### Task 9: EditorController — stdin/raw-mode glue

**Files:**
- Create: `packages/core/src/editor/controller.ts`
- Create: `packages/core/src/editor/index.ts` (barrel)
- Test: `packages/core/tests/editor-controller.test.ts` (driven by a fake stdin EventEmitter + fake out sink — no real TTY)

**Interfaces:**
- Produces: `export interface IEditorHandle { onSubmit(cb: (message: string) => void): void; onChange(cb: () => void): void; getBuffer(): EditorBuffer; close(): void; } export function startEditor(deps: { stdin: NodeJS.ReadStream | FakeStdin; out: (s: string) => void; statusBar?: …; openPalette?: () => Promise<void>; openFilePicker?: () => Promise<void>; }): IEditorHandle`. Wires bytes → `PasteScanner` (paste → `buffer.insertPaste`, swallow during `active`) → `decodeKeys` → `EditorBuffer` ops via a key→action table; repaints via `renderEditor` + the out sink; calls `onSubmit(buffer.expand())` on Enter (no mods); inserts newline on Shift/Alt+Enter and trailing-`\`+Enter; triggers `openPalette`/`openFilePicker` on the same conditions cli.ts uses today. Enables `\x1b[?2004h`, Kitty (`\x1b[>1u`) + modifyOtherKeys (`\x1b[>4;2m`) on start (env-gated); disables all on `close()`. Sets/unsets raw mode if `stdin.setRawMode` exists.

- [ ] **Step 1: Write failing tests with a fake stdin**

```ts
// FakeStdin: an EventEmitter with setRawMode/resume/setEncoding no-ops that
// re-emits "data" when you call .feed(s).
test("typing then Enter submits the typed text once", () => {
  const { stdin, handle, submits } = makeHarness();
  stdin.feed("hi");
  stdin.feed("\r");
  expect(submits).toEqual(["hi"]);
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
});

test("a multi-line paste lands in the buffer and submits once on Enter", () => {
  const { stdin, handle, submits } = makeHarness();
  stdin.feed("\x1b[200~one\rtwo\rthree\x1b[201~");
  expect(submits).toEqual([]); // never auto-submits
  expect(handle.getBuffer().getText()).toBe("one\ntwo\nthree");
  stdin.feed("\r");
  expect(submits).toEqual(["one\ntwo\nthree"]);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the controller + a `FakeStdin` test helper. Key→action table maps decoded `IKeyEvent`s to `EditorBuffer` methods; `return` with no mods → submit; `return` with shift/alt → `newline()`; trailing-`\` rule: if Enter and the char before cursor is `\`, delete it and `newline()`. Paste path: while `scanner.isActive()` swallow decoded keys; on completed content call `buffer.insertPaste(content)` + repaint. Guard repaint behind the out sink.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(editor): EditorController (raw stdin glue, submit/newline/paste wiring)`.

---

### Task 10: Integrate into cli.ts (replace readline; preserve steer/Ctrl-C/history/palette; fallback)

**Files:**
- Modify: `packages/core/src/cli.ts` (the `runInteractive` input wiring, ~lines 916-1715)
- Modify: `packages/core/src/config/config.constants.ts` + `flags.ts` (add `basicInput` → `TSFORGE_BASIC_INPUT`)
- Test: `packages/core/tests/cli.test.ts` (append a wiring test using the fake stdin)

**Interfaces:**
- Consumes: `startEditor` from `editor/index.ts`; `flags.basicInput()`.
- Produces: when `useInputRow && !flags.basicInput()`, the interactive loop drives input through `startEditor` instead of `rl.on("line")`. `onSubmit(message)` calls the existing `submitLine`/busy/`pending` logic verbatim. History (load/save), Ctrl-C (abort vs quit), the `/` palette and `@` picker, and the status bar all keep working. `TSFORGE_BASIC_INPUT=1` or a non-TTY keeps the current readline path unchanged.

- [ ] **Step 1: Write a wiring test** — with the fake stdin, feed a paste + Enter and assert `submitLine` receives ONE multi-line message (and, while "busy", it `pending`-queues exactly one steer).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the branch: build the editor handle, route `onSubmit` to `submitLine`, keep `pending`/`busy`/Ctrl-C, remove the per-line readline path under the new branch (leave it intact under the fallback). Add the flag. Disable bracketed-paste/Kitty/modifyOtherKeys + restore raw mode in the same teardown that calls `statusBar.teardown()`.

- [ ] **Step 4: Run → PASS** + full `bun run validate`.

- [ ] **Step 5: Commit** `feat(cli): drive the interactive prompt through the multi-line editor (TSFORGE_BASIC_INPUT fallback)`.

---

### Task 11: Live verification + docs

**Files:**
- Modify: `apps/docs/src/content/docs/...` (a short "input editor" note: keys, Shift+Enter, paste, fallback)
- Modify: `packages/core/RULES.md` or the keybinding help if one exists

- [ ] **Step 1:** Run the real CLI on a sample repo and verify by hand: type; Shift+Enter and Alt+Enter newlines; `\`+Enter newline; paste a multi-line block (lands in buffer, one message on Enter); `/` palette + `@` picker; ↑/↓ history at buffer edges; Ctrl-C abort vs quit; resize. Confirm `TSFORGE_BASIC_INPUT=1` falls back to readline cleanly.
- [ ] **Step 2:** Document the keys + the fallback flag.
- [ ] **Step 3:** `bun run validate` green; commit `docs(editor): document the multi-line input editor + keys`.

---

## Self-review notes

- **Spec coverage:** buffer model (T1-5), key decoding incl. Shift/Alt/Ctrl+Enter (T6), bracketed paste + markers + timeout (T5,T7), rendering (T8), controller + protocol handshake + `/`+`@` (T9), cli integration + fallback + history/steer/Ctrl-C (T10), live verify + docs (T11). All spec sections map to a task.
- **Deferred (noted in spec non-goals / T5):** atomic paste-marker segmentation in cursor/wrap is v1-simplified (marker is plain text that round-trips via `expand`); full atomic segmentation is a fast-follow.
- **Type consistency:** `EditorBuffer` method names are reused verbatim across T1-T10; `decodeKeys`/`IKeyEvent`, `createPasteScanner`/`feed`/`forceEnd`, `renderEditor`, `startEditor`/`IEditorHandle` are referenced with the same signatures in the controller and cli tasks.
