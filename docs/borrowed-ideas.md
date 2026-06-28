# Borrowed ideas — harness improvements

Ideas worth taking from other projects, framed the way we approached OpenTUI:
not "cool repo" but "this repo solves a problem one of our subsystems solves
badly — here's the borrowable *mechanism* and where it lands in our tree."

Guiding principle (north star): **lift local models by removing harness
friction** — fix the turn-multiplying ergonomics, don't blame model "slowness".

**Already shipped:** OpenTUI ideas (Unicode display width, LCS diff renderer,
layout primitive, damage-tracking screen buffer) — released in `0.25.0`.

**Already in the tree (don't re-add):** ranked repo map (`codebase/build-map.ts`,
`rank-hubs.ts`), LSP integration (`lsp/`), property testing (`proptest/`), eval
suite (`eval/`, `sweep`), ast-grep gate, MCP, browser oracle, post-hoc tool-call
salvage.

---

## ⭐ Top 3 — execute now

### 1. Constrained / structured decoding (vLLM structured outputs)

**Status: feasibility VERIFIED** against the live endpoint (`192.168.20.108:8000`,
DeepSeek-V4-Flash, vLLM nightly). Both `response_format: {type:"json_schema",
strict}` and native `tools` + `tool_choice` work — even with MTP speculative
decoding — returning schema-conformant output. See memory
`vllm-constrained-decoding-supported`.

- **Borrow:** constrain tool-call / structured output *at generation time* instead
  of only repairing malformed output afterward. `salvage-toolcall` becomes the
  fallback for endpoints without guided decoding, not the primary path.
- **Inspiration:** vLLM structured outputs (xgrammar), llama.cpp GBNF, BAML.
- **Where:** `inference/request.ts`, `inference/wire.ts`,
  `inference/openai-compatible.ts`, `inference/inference.types.ts`;
  `loop/session.ts`; `loop/tools/execute-tool.ts`.
- **Plan:**
  1. Capability probe: detect guided-decoding support per endpoint (cache it;
     a `/v1/models` ping + a tiny `response_format` smoke test, or config opt-in).
  2. When supported, emit `tools` + `tool_choice` (and/or `response_format`
     json_schema) on the wire for tool-call turns; keep salvage as fallback.
  3. Add a config/env switch so cloud endpoints without it degrade gracefully.
- **Effort:** M. **Risk:** low (additive; fallback preserved). **ROI:** highest.
- **Done when:** a tool-call turn against the local endpoint returns a
  schema-valid call without invoking salvage, and salvage still covers a
  capability-off endpoint (test both paths).

### 2. SWE-agent Agent-Computer Interface (tool ergonomics)

- **Borrow:** the thesis that *tool ergonomics decide success more than the model*.
  A bounded, line-numbered file viewer with a scroll window (not raw dumps); edit
  tools that **echo back the changed window + the lint/gate result** in the tool
  response; malformed edits rejected with a corrective message, not a silent fail.
- **Inspiration:** `princeton-nlp/SWE-agent` (ACI), Codex CLI tool design.
- **Where:** `loop/tools/file-ops.ts`, `loop/tools/edit-hashline.ts`,
  `files/edit.ts`, `loop/tools/execute-tool.ts`, `loop/tools/tool-context.ts`.
- **Effort:** M. **Risk:** low. **ROI:** high (no endpoint dependency).
- **Done when:** read/edit tool responses carry window + outcome context, and an
  eval shows fewer wasted "re-read the file" turns.

### 3. Robust edit application + lenient output parsing

- **Borrow (a):** aider's search/replace edit format with **whitespace-tolerant /
  fuzzy matching** and a precise "that block didn't match, here's the closest
  context" retry — far more forgiving than exact-string replace.
- **Borrow (b):** BAML's **Schema-Aligned Parsing** — coerce almost-valid model
  output (trailing commas, prose around JSON, wrong quoting) into a typed result;
  upgrades the salvage path.
- **Inspiration:** `Aider-AI/aider`, `BoundaryML/baml`.
- **Where:** `files/edit.ts`, `loop/tools/edit-hashline.ts`;
  `inference/openai-compatible.ts`, `inference/wire.ts` (salvage).
- **Effort:** M. **Risk:** medium (touches the edit hot path — gate with the
  existing `files-edit` / `salvage-toolcall` tests). **ROI:** high.
- **Done when:** near-miss edits (whitespace/indent drift) apply instead of
  failing, and malformed-but-recoverable tool calls parse without a retry.

---

## Backlog (by subsystem)

### Edit / diff rendering
- **difftastic** (`Wilfred/difftastic`) — structural, tree-sitter diffing. Renders
  a one-token change as one token, not whole-line churn. Enhances `render/diff.ts`
  and gives the model tighter change context. *Effort M, ROI medium.*

### TUI / rendering
- **Charm Glamour / Bubble Tea / Lipgloss** (`charmbracelet`) — Glamour is a polished
  terminal Markdown renderer (compare `render/markdown.ts`, `stream-markdown.ts`);
  Bubble Tea's Elm update/view discipline is a design reference. *ROI low–med.*
- **Ratatui** (Rust) — constraint-solver layout (`Length/Min/Ratio`); the mature
  form of our `render/layout.ts` `computeRegions`, if layout grows to split panes.

### Gate / guardrails
- **oxc / oxlint** — Rust JS/TS linter ~50–100× faster than ESLint; a fast first-pass
  to shorten build→fix latency (ESLint only for rules it lacks). `detect-gate.ts`,
  `validate/`. *ROI med if gate latency bites.*
- **knip** — unused exports/deps detection → new gate check.
- **dependency-cruiser** — module-boundary / architectural rules → new gate check.

### Eval / benchmarking
- **inspect_ai** (`UKGovernmentBEIS/inspect_ai`) — clean `solver`/`scorer`/`dataset`
  separation and structured logs; mirror the abstractions in `eval/` + `sweep`.
- **SWE-bench harness** — patch-apply-then-run-tests verification model for `eval/`.

### Structured output / decoding (beyond Top-3 #1)
- **llama.cpp GBNF / outlines / guidance** — grammar backends if we want grammar
  constraints richer than JSON Schema (e.g. constrained DSLs).
