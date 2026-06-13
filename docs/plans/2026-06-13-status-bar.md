# Always-visible status bar (scroll-region pin)

**Date:** 2026-06-13
**Status:** approved design → implementation

## Context

tsforge's interactive CLI is a raw `readline` streaming loop (`packages/core/src/cli.ts`). Its "status line" is a dim one-liner reprinted above each `›` prompt (`renderStatus` in `render/ansi.ts`) — it scrolls away with output, so there's no persistent at-a-glance view of model / context / throughput.

Harnesses we admire (`../pi`, Claude Code) solve this with full TUI render loops that own the screen and re-pin a footer every frame. tsforge is not a TUI and a rewrite is out of scope. Instead we get the same *always-visible* UX with the standard readline-CLI technique: an ANSI scroll region (`DECSTBM`) that reserves the bottom rows for a bar while normal output scrolls above it.

## Goals

- A styled status bar pinned to the terminal bottom, always visible while output streams.
- Live updates: context %, tokens/sec, turns, elapsed, last status, scope, model.
- Zero disruption to streaming output and readline input.
- Graceful, automatic fallback to the current inline line for non-TTY / piped / `--log` runs.
- No new runtime dependencies; reuse the existing `STYLE`/`paint` layer.

## Non-goals

- A full TUI / render-loop rewrite (pi-style). Explicitly deferred.
- Mouse, scrollback capture, or multi-pane layout.

## Design

### Mechanism (scroll region)

On install (interactive + `process.stdout.isTTY` only):
1. Read `rows`/`columns` from `process.stdout`.
2. Reserve the bottom `BAR_ROWS` (1, room to grow to 2) rows: set scroll region to `ESC[1;{rows-BAR_ROWS}r`. All streaming output, the renderer, and readline now scroll within rows `1..rows-BAR_ROWS`.
3. Draw the bar: save cursor (`ESC7`) → move to the first reserved row (`ESC[{rows-BAR_ROWS+1};1H`) → clear line (`ESC[2K`) → write the painted, width-truncated bar → restore cursor (`ESC8`).

`update(info)` repeats step 3 only (cheap; no region change). Called from the event stream on `usage` (live tok/s), turn boundaries, and gate verdicts, and once after each send settles.

### Resize

Listen for `process.stdout.on("resize")`: recompute rows/cols, re-issue the scroll-region set, redraw the bar. Debounce trivially (coalesce synchronous bursts).

### Teardown

On session close, `SIGINT`, and `process.on("exit")`: reset the scroll region (`ESC[r`), move the cursor below the content, show the cursor (`ESC[?25h`). Idempotent and guarded so a crash can't leave the terminal in a reserved-region state.

### Fallback

If not a TTY, or `--log`/headless, or `rows < 4`, or `NO_COLOR`/dumb terminal: do **not** install the scroll region. The CLI keeps printing the existing inline status line before each prompt. This keeps piped output and logs clean and avoids tiny-terminal breakage.

### Module boundaries

- **`render/status-bar.ts`** — the controller `class StatusBar`:
  - `install()`, `update(info: IStatusInfo)`, `handleResize()`, `teardown()`, and `readonly active: boolean`.
  - A **pure** helper `buildBarFrame(info, cols, rows): string` that returns the exact escape string (region-independent), so it is unit-testable without a terminal.
  - Construction decides active vs inactive from an injected `{ isTTY, rows, columns, enabled }` so tests can drive both paths.
- **`render/ansi.ts`** — factor the current segment assembly out of `renderStatus` into a shared `statusSegments(info): string` used by both the inline line and the bar (single source of truth for content/colors/truncation). `renderStatus` stays for the fallback.
- **`cli.ts`** — instantiate `StatusBar`; if active, stop printing the inline line in `prompt()` and instead `bar.update(...)` from the event stream + after each send; if inactive, keep today's behavior. Wire `teardown()` into the existing close/SIGINT paths.

### Bar content

`qwen3.6-27b  ▕███▏ 25%  ⚡ 48 tok/s · ↻ 2 · 12s · ✓ done · src/**`
— reuses `IStatusInfo` (already carries model, contextTokens/Window, turns, elapsedMs, status, scope, tokensPerSecond). Painted dim with the meter/percent colored by usage, truncated to `columns`.

## Testing

- `buildBarFrame` / `statusSegments`: pure unit tests — correct row targeting (`rows-BAR_ROWS+1`), all segments present, width truncation at small `columns`, color on/off.
- `StatusBar` inactive path: with `isTTY:false` it emits nothing and `active === false` (CLI uses inline fallback).
- Terminal behavior (actual pinning, resize, Ctrl-C teardown) is manually verified — documented in the interactive-CLI doc.

## Docs

Update `cli/interactive.mdx` (status bar described + screenshot-style example) and cross-link from `observability/metrics.mdx` (tok/s lives in the bar).

## Rollout

Interactive CLI only; no package API change beyond new exports. Lands as a normal patch release. The scroll-region path is opt-out-safe (inactive whenever not a real terminal).
