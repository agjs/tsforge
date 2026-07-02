# Status bar: relative-redraw rearchitecture (resize-proof)

## Why
The bar is pinned to the screen bottom via a DECSTBM scroll region + absolute
positioning. On resize the terminal reflows and orphans the absolutely-positioned
bar at an unpredictable row (mid-screen on grow). No position-guess or
bottom-anchored clear removes it reliably. Root fix: stop pinning via scroll
region; draw the live region (bar + input + editor) relative to the content and
erase-to-end (`ESC[0J`) on every repaint — reflow-proof by construction.

## Model (log-update / Ink style)
- No DECSTBM. Conversation is plain scrollback; the terminal reflows it correctly.
- The **live region** is the last `liveRows` terminal rows, immediately after content.
- `render(frameLines, cursorRowInRegion, cursorColInRegion)`:
  1. If `liveRows > 0`: `ESC[<liveRows-1>A` (up to region top, if >1) + `\r` + `ESC[0J` (erase to end).
     Else `\r` + `ESC[0J`.
  2. Write `frameLines.join("\r\n")` (NO trailing newline — a trailing newline scrolls).
  3. Park cursor: from the last line, `ESC[<n>A` up to the cursor's row, `\r`, `ESC[<col>C`.
  4. `liveRows = frameLines.length`.
- `writeStream(text)`: erase live region (step 1), write `text` normalized to CRLF
  (content flows, may scroll old content off top), then `render(...)` the live region
  below it. Cursor ends parked in the region.

## Contract to preserve (StatusBar public API — call sites in cli.ts)
`active, install, update, setInput, writeStream, pauseForResize, flushStream,
setOverlay, clearOverlay, setEditor, setEditorOverlay, clearEditorOverlay, resize,
teardown`. Behaviour parity for everything EXCEPT: bar sits under content (not glued
to screen bottom); no scroll region emitted.

## Frame assembly
Build the live region as an ordered array of lines (top→bottom):
1. overlay/`@`-picker lines (if any)
2. editor block lines (multi-line input) OR the single input row (`› …`)
3. border rule (`╶───`)
4. segments line (model · meter · status · scope)
The cursor parks on the editor/input line at its typing column.
Reuse `barSegments/assemble/topBorder/clipInput/wrapLine` for CONTENT; drop the
absolute-CUP wrappers (buildBarBody/buildInputFrame/... emit `ESC[r;cH` — replace
with array-of-lines producers).

## Flicker
Relative erase+redraw repaints the whole region per update. Region is small
(≤ a few rows typically), so full redraw is fine (this is how Ink works). Keep the
`ScreenBuffer` diff only if flicker shows in testing; otherwise remove it.

## Stages (each ends at a user-verifiable checkpoint)
1. **Core primitive + bar-only + input row.** New `render()`/`writeStream()` on the
   relative model; wire `install/update/setInput/writeStream/resize/teardown`.
   Keep editor/overlay temporarily delegating to a simple path. Adapt unit tests
   (VirtualScreen asserts rendered grid; drop scroll-region byte assertions).
   → USER TEST: type, stream a turn, resize (grow/shrink/circular). Expect: one bar,
   under content, no orphans, no disappear.
2. **Editor block** (multi-line input) in the relative frame + cursor parking.
   → USER TEST: multi-line paste, long line, resize mid-edit.
3. **Overlays** (`@`-picker, command palette, editor overlay).
   → USER TEST: `@` picker + resize.
4. **Cleanup**: remove scroll-region/ScreenBuffer remnants if unused; final gate.

## Verification reality
The automated iTerm2 harness can't drive a fast-enough drag to referee resize, so
each stage's resize check is manual (user). Non-resize behaviour is covered by the
existing status-bar/editor-e2e VirtualScreen tests.
