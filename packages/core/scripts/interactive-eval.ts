#!/usr/bin/env bun
// INTERACTIVE-PATH eval: drives Session.send() exactly the way the REPL does —
// agent-decides scaffold_web, plan mode, the malformed-call retry — the paths
// headless-build (which pre-scaffolds and calls buildStaged) never exercises.
// This net exists because a missing `scaffoldWeb: true` config flag killed the
// agent-decides path for weeks and no eval noticed.
//
//   bun packages/core/scripts/interactive-eval.ts                       # default todo-app prompt
//   bun packages/core/scripts/interactive-eval.ts "build a notes app"   # custom prompt
//   ... --plan    exercise plan mode (plan → approve → implement)
//   ... --force   forced-tools arm (tool_choice required + yield_status)
//
// Each run gets evals/runs/<timestamp>-interactive[-flags]/ with agent.log,
// the JSONL event log, and a verdict.json for the analyzer.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Session,
  PLAN_APPROVED_NOTE,
  LOOP_LIMITS,
  type ISendResult,
} from "../src/loop";
import { renderEvent, type Reporter } from "../src";
import {
  buildGate,
  buildWebGate,
  buildWebFix,
  buildWebTscCheck,
  scaffoldWeb,
  installWebDeps,
  webGuidance,
} from "../src/detect-gate";
import { resolveActiveModel } from "../src/models-config";
import { OpenAICompatibleProvider } from "../src/inference";
import { providerConfig } from "../src/cli";

interface IVerdict {
  status: string;
  turns: number;
  scaffolded: boolean;
  planUsed: boolean;
  forceTools: boolean;
  malformedNudges: number;
  salvaged: number;
  toolRejections: number;
}

function makeReporter(
  logFile: string,
  agentLog: string,
  verdict: IVerdict
): Reporter {
  return (event) => {
    process.stdout.write(renderEvent(event, { color: true }));
    appendFileSync(agentLog, renderEvent(event, { color: false }));
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);

    // Live fingerprints for the verdict (same markers analyze-malformed reads).
    if (event.kind === "tool") {
      if (event.message.includes("malformed tool-call text")) {
        verdict.malformedNudges += 1;
      }

      if (event.message.startsWith("tool_rejected:")) {
        verdict.toolRejections += 1;
      }

      if (
        event.message.includes("recovered") &&
        event.message.includes("malformed")
      ) {
        verdict.salvaged += 1;
      }
    }
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const plan = argv.includes("--plan");
  const force = argv.includes("--force");
  const prompt =
    argv.find((a) => !a.startsWith("--")) ?? "build a small todo web app";

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  const label = `interactive${plan ? "-plan" : ""}${force ? "-force" : ""}`;
  const dir = resolve(join("evals", "runs", `${stamp}-${label}`));

  mkdirSync(dir, { recursive: true });

  const verdict: IVerdict = {
    status: "unknown",
    turns: 0,
    scaffolded: false,
    planUsed: plan,
    forceTools: force,
    malformedNudges: 0,
    salvaged: 0,
    toolRejections: 0,
  };
  const report = makeReporter(
    join(dir, "events.jsonl"),
    join(dir, "agent.log"),
    verdict
  );

  const active = await resolveActiveModel();
  const provider = new OpenAICompatibleProvider(providerConfig(active.entry));
  const gate = await buildGate(dir);

  process.stdout.write(
    `interactive eval → ${dir}\n  model ${active.name} · gate ${gate.label} · ${plan ? "plan-mode" : "direct"}${force ? " · forced-tools" : ""}\n\n`
  );

  // The REPL's exact config shape — scaffoldWeb:true is the agent-decides flag.
  const session = await Session.create({
    provider,
    cwd: dir,
    files: ["**/*"],
    accept: gate.command,
    report,
    scaffoldWeb: true,
    enableThinking: false,
    ...(force ? { forceTools: true } : {}),
  });

  // The REPL's configureWeb, inlined: scaffold + deps + switch to the web gate.
  session.setSetupWeb(async (framework) => {
    const fw = framework === "vanilla" ? "vanilla" : "react";

    await scaffoldWeb(dir, fw);
    await installWebDeps(dir);
    session.setGate(buildWebGate(fw).command);
    session.setFix(buildWebFix(fw));
    session.setIncrementalCheck(buildWebTscCheck());
    session.guide(webGuidance(fw));
    session.setMaxTurns(LOOP_LIMITS.webMaxTurns);
    verdict.scaffolded = true;
  });

  let result: ISendResult;

  if (plan) {
    session.setPlanMode(true);
    result = await session.send(prompt);

    const planned = session.messages.at(-1)?.content ?? "";

    process.stdout.write(
      `\n— plan turn: ${result.status}; ## Plan present: ${String(/^##\s*plan\b/im.test(planned))} —\n`
    );
    session.setPlanMode(false);
    result = await session.send(PLAN_APPROVED_NOTE);
  } else {
    result = await session.send(prompt);
  }

  verdict.status = result.status;
  verdict.turns = result.turns;
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2));

  process.stdout.write(
    `\nverdict: ${JSON.stringify(verdict)}\n  run dir: ${dir}\n`
  );

  return result.status === "done" && verdict.scaffolded ? 0 : 1;
}

process.exit(await main());
