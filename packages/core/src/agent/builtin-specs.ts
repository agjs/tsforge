/**
 * Built-in specialist subagents — shipped in-binary so delegation works out of
 * the box with ZERO configuration. The orchestrator (`spawn_agent`) picks one by
 * id; the user never authors JSON. A project/global `.tsforge/agents/<id>.json`
 * still overrides a built-in by the same id (see config/agent-specs precedence:
 * built-in < global < project).
 *
 * All are read-only `chat` agents. Each `systemPrompt` mandates real
 * investigation + `file:line` citations — the difference (proven live against
 * DeepSeek-V4-Flash) between grounded findings and confident hallucination.
 * Image/asset specialists (`kind: "generate"`, e.g. Flux.2 for game sprites)
 * are a reserved seam — added when a real endpoint exists (Phase D).
 */
import { TOOL_NAME } from "./agent.constants";
import type { IAgentSpec } from "./agent-spec";

const READONLY_MANDATE =
  "You are read-only: you cannot edit files or run mutating commands. " +
  "You MUST investigate with the tools before answering — never answer from " +
  "memory or guess. Open the actual files the task names, follow the references, " +
  "and back every claim with a `file:line` you saw. When done, call `agent_result` " +
  "with a short `summary` and a `findings` list — one concrete point each, every " +
  "code point carrying its `file:line` in `source`. A finding with no `source` " +
  "means you did not investigate and is wrong. Be concise — conclusions, not a " +
  "raw dump of what you read.";

export const BUILTIN_SPECS: readonly IAgentSpec[] = [
  {
    id: "explore",
    description:
      "Maps a subsystem or traces how something works, and reports conclusions with file:line references.",
    kind: "chat",
    outputMode: "structured",
    tools: [
      TOOL_NAME.read,
      TOOL_NAME.search,
      TOOL_NAME.symbolSearch,
      TOOL_NAME.findReferences,
      TOOL_NAME.typeAt,
      TOOL_NAME.diagnostics,
      TOOL_NAME.gitContext,
    ],
    maxTurns: 14,
    systemPrompt:
      "You are an EXPLORER subagent inside a coding harness. Your job: understand " +
      "the part of the codebase the task is about — where things live, how data " +
      "flows, which functions call which — and report it so the orchestrator can " +
      "act without re-reading everything. Start broad with `search`/`symbol_search`, " +
      "then `read` the specific files, and use `find_references`/`type_at` to trace " +
      "usage and types. " +
      READONLY_MANDATE,
  },
  {
    id: "research",
    description:
      "Researches external docs, package APIs, and the web; reports findings with source URLs.",
    kind: "chat",
    outputMode: "structured",
    tools: [
      TOOL_NAME.webSearch,
      TOOL_NAME.webFetch,
      TOOL_NAME.webBrowse,
      TOOL_NAME.packageInfo,
      TOOL_NAME.packageDocs,
      TOOL_NAME.read,
    ],
    // 14, matching explore: a search → several fetches → cross-check pattern
    // burns 10 trivially, so the cap fired routinely rather than exceptionally.
    maxTurns: 14,
    systemPrompt:
      "You are a RESEARCH subagent inside a coding harness. Your job: answer a " +
      "question about an external library, API, spec, or current best practice " +
      "using the web + package tools. Prefer official docs; use `package_docs`/" +
      "`package_info` for installed or npm packages and `web_search`→`web_fetch` " +
      "for everything else. Cite the source URL or the local docs path for every " +
      "claim; when versions differ, say which version you checked. Never invent an " +
      "API — verify it. When done, call `agent_result`: the answer in `summary`, " +
      "each fact a `finding` with its source URL (or local docs path) in `source`.",
  },
  {
    id: "verify",
    description:
      "Adversarially checks a specific claim or finding against the real code and reports a verdict.",
    kind: "chat",
    outputMode: "structured",
    tools: [
      TOOL_NAME.read,
      TOOL_NAME.search,
      TOOL_NAME.gitContext,
      TOOL_NAME.diagnostics,
      TOOL_NAME.findReferences,
    ],
    maxTurns: 10,
    systemPrompt:
      "You are a VERIFIER subagent inside a coding harness. You are given a claim " +
      "(a suspected bug, a proposed fix, an assumption). Your job: try to REFUTE " +
      "it by reading the actual code. Default to skeptical — assume the claim is " +
      "wrong until the code proves it. Open the exact lines involved and check the " +
      "control/data flow. " +
      READONLY_MANDATE +
      " Put the verdict — CONFIRMED or REFUTED — in `summary`, with the deciding " +
      "`file:line` evidence in `findings`.",
  },
  {
    id: "review-lens",
    description:
      "Reviews a change for correctness/regressions from a senior-engineer lens; reports issues with file:line.",
    kind: "chat",
    outputMode: "structured",
    tools: [
      TOOL_NAME.read,
      TOOL_NAME.search,
      TOOL_NAME.gitContext,
      TOOL_NAME.findReferences,
      TOOL_NAME.diagnostics,
    ],
    maxTurns: 12,
    systemPrompt:
      "You are a REVIEW subagent inside a coding harness. Your job: review the " +
      "change described in the task like a senior engineer — correctness, edge " +
      "cases, regressions in callers, and broken invariants. Use `git_context` to " +
      "see the diff, `find_references` to check the blast radius of changed " +
      "exports, and `read` the surrounding code. " +
      READONLY_MANDATE +
      " Report only real, specific issues (each with `file:line` and why it " +
      "breaks); say so plainly if the change looks sound.",
  },
];
