# Design: a best-in-class multi-line input editor for tsforge

## Context

tsforge's interactive prompt uses Node `readline`, which is single-line and
**submits on every newline**. Pasting a multi-line block therefore fires one
submission per line (N messages, or N mid-run "steer" notices) — the reported
bug. The deeper problem is the primitive: readline can't hold or edit multi-line
input, so there is no "paste, add context, then submit" and no Shift+Enter.

Both reference agents avoid this by **owning a multi-line editor**: pi ships a
custom TUI editor (`packages/tui`), hermes uses prompt_toolkit (multiline) + an
Ink editor. This spec replaces readline for the interactive prompt with our own
grapheme-aware multi-line editor — the input is the product's front door, so it
should be best-in-class.

The editor is **default and always-on**; `TSFORGE_BASIC_INPUT=1` falls back to
the current readline path as a safety hatch.

## Goals

- True multi-line editing: **Enter submits, Shift+Enter / Alt+Enter / trailing
  `\`+Enter insert a newline**. Paste lands in the buffer and **never**
  auto-submits.
- Grapheme-correct everywhere (emoji, combining marks, CJK width).
- Bracketed paste: capture the block, normalize newlines, collapse huge pastes to
  `[paste #N +M lines]` markers that expand on submit, with a timeout valve for a
  missing end marker.
- Full editing: word/line/document cursor moves, word/line/to-edge deletes,
  kill-ring + yank, coalesced undo/redo, input history.
- Preserve today's UX: the `/` command palette, the `@` file picker, mid-run
  steering, Ctrl-C semantics, and the pinned status bar — folded into the editor.
- Fully testable without a PTY (pure buffer/decoder/paste units + FakeTerm frame
  tests for rendering).

## Non-goals (v1)

- Syntax highlighting / bracket matching in the input.
- Mouse selection. Image-from-clipboard paste (note the seam; defer).
- Vi keybindings (emacs-style + arrows only).

## Architecture

A new `packages/core/src/editor/` module, pure where possible, wired into
`cli.ts`'s `runInteractive`. Boundaries:

1. **`EditorBuffer`** (`editor/buffer.ts`) — pure model. State: `lines: string[]`,
   `cursorLine`, `cursorCol` (grapheme index), selection-less. Operations return a
   new/mutated state; no I/O, no ANSI. Owns: insert text, newline, delete
   (char/word/line/to-edge), cursor moves (char/word/line/home/end/doc) with
   **sticky column** for vertical moves, undo/redo (snapshot stack with
   fish-style coalescing), kill-ring + yank/yank-pop, large-paste markers +
   `expand()` on submit. Grapheme segmentation via `Intl.Segmenter`.

2. **`KeyDecoder`** (`editor/keys.ts`) — pure. Decodes a raw stdin chunk into a
   sequence of normalized `KeyEvent { name, ctrl, alt, shift, text }`. Handles
   Kitty CSI-u (`ESC[<cp>;<mod>u`), xterm `modifyOtherKeys`
   (`ESC[27;<mod>;<cp>~`), and legacy sequences. This is what makes Shift+Enter /
   Ctrl+Enter distinguishable.

3. **`PasteScanner`** (`editor/paste.ts`, already drafted) — extracts the
   bracketed-paste block (`ESC[200~`…`ESC[201~`), normalizes `\r`/`\r\n`→`\n`,
   spans chunks, exposes `active` so the driver knows a paste is open; plus a
   missing-`201~` timeout valve.

4. **`EditorView`** (`editor/view.ts`) — pure render: given buffer + viewport
   (cols/rows), produce the ANSI frame for a multi-row input box (word-wrap,
   scroll with `↑/↓ N more` indicators, cursor cell, prompt gutter). Reuses the
   `status-bar` scroll-region discipline. FakeTerm-assertable like
   `buildInputFrame`.

5. **`EditorController`** (`editor/controller.ts`) — the glue: owns stdin in raw
   mode, runs the terminal-protocol handshake, feeds bytes → PasteScanner →
   KeyDecoder → EditorBuffer, repaints via EditorView + statusBar, and surfaces
   callbacks: `onSubmit(message)`, `onChange`, plus hooks for the `/` palette and
   `@` picker (opened on the same triggers as today). Replaces the readline
   instance in `runInteractive`.

`cli.ts` keeps everything else: the busy/steer queue (`pending`), Ctrl-C abort vs
quit, history persistence, status bar, prompt lifecycle — it just consumes
`EditorController` events instead of `rl.on("line")`.

## Submit vs. newline (the crux)

- **Enter** (`\r`, no mods) → submit.
- **Shift+Enter**, **Alt+Enter** (`ESC\r`), and a **trailing `\` + Enter** →
  insert newline. Alt+Enter and `\`+Enter always work even on terminals that
  can't encode Shift+Enter.
- To make Shift+Enter reliable, the controller enables the **Kitty keyboard
  protocol** (`ESC[>1u`) and **xterm modifyOtherKeys** (`ESC[>4;2m`) on start and
  disables them on teardown, with **env gating** (hermes' lesson: Windows/WSL/SSH/
  Ghostty/WT deliver Ctrl+Enter as bare LF) so we never mis-bind bare LF.
- Bracketed paste is enabled with `ESC[?2004h` (disabled on teardown). Pasted
  newlines insert into the buffer; they are not Enter.

## Keybindings (v1, emacs + arrows)

Move: ←/→ char, Ctrl/Alt+←/→ word, Home/End line, Ctrl+Home/End document, ↑/↓
visual line (sticky column; at top/bottom edge → history prev/next). Delete:
Backspace/Delete char, Ctrl+W / Alt+Backspace word-back, Alt+D word-forward,
Ctrl+U to line-start, Ctrl+K to line-end. Kill-ring: Ctrl+W/U/K push; Ctrl+Y
yank; Alt+Y yank-pop. Undo: Ctrl+_ (and Ctrl+Z where the terminal delivers it);
redo: Alt+_ (avoids the Ctrl+Y/yank collision); undo steps coalesce per word.
Submit/newline as above. Ctrl+C: abort the run if busy, else clear the buffer; a
second Ctrl+C on an empty buffer quits (preserving current behavior). `/` at
col 0 opens the palette; `@` at a word boundary opens the file picker.

## Bracketed paste + large pastes

Capture the block via `PasteScanner`; normalize newlines; strip non-printables
(keep `\n`); decode CSI-u-encoded control bytes that tmux re-emits inside pastes.
If the paste is > ~10 lines or > ~1000 chars, insert a `[paste #N +M lines]`
marker (atomic for cursor/wrap) and stash the real text in a `Map`; `expand()`
substitutes markers at submit. A missing `ESC[201~` within ~2s ends the paste
(timeout valve) so the editor can't wedge.

## Rendering

`EditorView` lays logical lines → visual lines (word-wrap at `cols`), shows a
bounded box (e.g. up to ~30% of rows, min 1) above the status bar, scroll
indicators when clipped, and the cursor cell. Single-line input renders exactly
like today (no visual regression for the common case). Paint stays within the
status-bar scroll region; teardown restores the terminal (and disables
2004/Kitty/modifyOtherKeys).

## Integration & migration

`runInteractive` swaps the `rl` line source for `EditorController` while keeping:
the `submitLine` path (now receives a possibly-multi-line message), the
busy/`pending` steer queue, Ctrl-C handling, history load/save, status bar, and
the `/`+`@` overlays. `TSFORGE_BASIC_INPUT=1` keeps the readline path verbatim as
a fallback. Non-TTY/pipe input keeps the existing readline behavior (the editor
is a TTY feature).

## Testing

- **Pure units (the bulk):** `EditorBuffer` (every op incl. grapheme/CJK, undo
  coalescing, kill-ring, sticky column, paste markers + expand), `KeyDecoder`
  (Kitty/modifyOtherKeys/legacy fixtures, incl. Shift/Alt/Ctrl+Enter), and
  `PasteScanner` against the **real captured bytes** (`ESC[200~…\r…ESC[201~`) plus
  multi-chunk and missing-end cases.
- **FakeTerm frame tests:** `EditorView` frames for single-line, wrapped
  multi-line, scrolled, and cursor-position cases (mirrors existing status-bar
  tests).
- Full `bun run validate` green; house rules (no `as`, cc ≤ 20, shared walkers).

## Rollout / verification

Land on `feat/multiline-editor`. Because TTY input can't be auto-tested under Bun
(no node-pty), the human verifies live in the real CLI: type, Shift+Enter for
newlines, paste a multi-line block (lands in buffer, one message on Enter), `/`
and `@` still work, Ctrl-C and history intact. Merge only after that live check.
`TSFORGE_BASIC_INPUT=1` is the instant rollback if anything regresses.

## File layout

```
packages/core/src/editor/
  buffer.ts        # EditorBuffer (pure model)
  keys.ts          # KeyDecoder (Kitty/modifyOtherKeys/legacy)
  paste.ts         # PasteScanner (+ large-paste markers, timeout)  [drafted]
  view.ts          # EditorView (pure ANSI frame)
  controller.ts    # EditorController (stdin/raw-mode glue)
  index.ts         # barrel
packages/core/tests/
  editor-buffer.test.ts
  editor-keys.test.ts
  editor-paste.test.ts
  editor-view.test.ts
```
