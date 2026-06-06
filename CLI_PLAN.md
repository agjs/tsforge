# CLI plan — the spine

tsforge's product surface is a **Claude-Code-class interactive CLI** you point at a real
repo to battle-test the loop on real code. The eval harness only MEASURES the engine; the
CLI is how a human drives it. Single spine — everything else is prerequisite or parked.

## Decisions (locked with user, 2026-06-06)
- **Invoke like any standard agentic harness**: interactive REPL, streaming output, Ctrl-C
  interrupt, slash commands (`/compact`, `/clear`, `/help`, `/exit`, …).
- **Gate model = "model-decides, gate-confirms"**: you converse; the agent works with
  tools/edits; when it stops calling tools, IF a gate is configured the deterministic gate
  runs as confirmation (green = accept, red = errors fed back, keep going). This is exactly
  how `runTask`/`settleGate` already decide "done" — the CLI is its natural extension. Keeps
  the "model can't fake completion" thesis.
- **Parked** (revisit only when a flagship/2nd judge model + real targets exist): all
  toy-target quality micro-levers (prettier-to-all-gates, callback-param annotation drop,
  `.entries()` lever, judge-rubric calibration). We've proven the model is strong on
  small/medium targets — no more mining that seam.

## Architecture
Extract the shared **turn primitives** into `loop/turn.ts` so there's ONE turn-loop, used by
both drivers (no duplication):
- `ILoopCtx` / `ILoopState`, `runToolCalls`, `settleGate`, `applyDeterministicFixes`,
  `polishOnGreen`, `buildTsService`, `toolsFor`, `NO_TOOL_CALL_NUDGE`, `BASE/ALL_TOOLS`.
- `run.ts` keeps `runTask` (the RED-first, drive-to-green wrapper for evals) + imports them.
- `loop/session.ts` (NEW) = the persistent conversational driver the CLI owns: holds
  `messages` + `cwd` + `tools` + `tsService` + optional `gate`; `send(text, {signal})` appends
  a user message, runs turns until the model stops calling tools, then settles the gate if one
  is set (else yields). Streams `ILoopEvent`s via `report`. This is also the compaction
  substrate ([[cli-product-direction]]).

## Slices (each: ship + verify; evals stay green)
1. **Session + interactive REPL.** Extract `turn.ts`; build `Session.send`; readline REPL in
   `cli.ts` (interactive when no positional task); render via existing `renderEvent`; slash
   dispatch `/help` `/clear` `/exit`. Keep the existing one-shot mode. *Verify: money +
   react-board eval smoke green; live REPL session against a real repo.*
2. **Abort.** Thread `AbortSignal`: SIGINT → `session.send` → `provider.complete` → `fetch`.
   Ctrl-C cleanly stops the current run, returns to the prompt; double-Ctrl-C / `/exit` quits.
3. **`/compact` + the rest.** Conversation summarize/evict (reuse projectMap navigation
   substrate); `/gate <cmd>`, `/add <files>`, `/model`, `/cost`, `/cwd`, …

## After the CLI proves out
Playwright e2e (app-level oracle) → bigger/real targets → resurrect judge calibration with a
real second model.

## Guardrails
Behavior-preserving extraction (runTask byte-identical behavior); eval smoke (money +
react-board) green after every slice; event-driven core stays console-I/O-free (renderEvent is
the only terminal piece); honest, no scatter — work the spine top to bottom.
