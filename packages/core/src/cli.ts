#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { runTask, RUN_STATUS } from "./loop";
import { PROVIDER_LIMITS, OpenAICompatibleProvider } from "./inference";
import { renderEvent } from "./render/ansi";
import type { ITask } from "./spec";

/**
 * The tsforge CLI — point it at a project + a task + a gate command and it drives
 * the agentic loop (work-on-existing: edits in place, never regenerates) until
 * the gate passes, streaming the work to the terminal. This is the PRODUCT surface
 * over the same `runTask` engine the eval harness uses (see cli-product-direction).
 *
 *   tsforge "<task>" --files "src/a.ts,src/b.ts" --accept "<gate command>" [--dir <path>]
 *
 * The gate command IS the goalpost (e.g. a failing test, `tsc`, a lint) — the loop
 * works until it exits 0. Provider via TSFORGE_BASE_URL/MODEL/API_KEY env.
 */
export interface ICliArgs {
  task: string;
  dir: string;
  files: string[];
  accept: string;
}

/** Parse argv (without `node script`). Returns null if required args are missing. */
export function parseArgs(argv: readonly string[]): ICliArgs | null {
  const positional: string[] = [];
  let dir = ".";
  let files: string[] = [];
  let accept = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    const next = argv[i + 1];
    const wantsValue =
      arg === "--dir" ||
      arg === "--files" ||
      arg === "--accept" ||
      arg === "--gate";

    if (wantsValue) {
      if (next === undefined) {
        continue;
      }

      if (arg === "--dir") {
        dir = next;
      } else if (arg === "--files") {
        files = next
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else {
        accept = next;
      }

      i += 1;
      continue;
    }

    positional.push(arg);
  }

  const task = positional.join(" ").trim();

  if (task.length === 0 || accept.length === 0 || files.length === 0) {
    return null;
  }

  return {
    task,
    dir: isAbsolute(dir) ? dir : join(process.cwd(), dir),
    files,
    accept,
  };
}

const USAGE =
  'usage: tsforge "<task>" --files "<glob,glob>" --accept "<gate command>" [--dir <path>]\n';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    process.stderr.write(USAGE);

    return 2;
  }

  const provider = new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? "http://192.168.20.107:8000/v1",
    model: process.env.TSFORGE_MODEL ?? "qwen3.6-27b",
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: Number(
      process.env.TSFORGE_MAX_TOKENS ?? String(PROVIDER_LIMITS.maxTokens)
    ),
  });

  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: args.files,
    context: [],
  };

  const result = await runTask(task, args.dir, provider, {
    onEvent: (event) => {
      process.stdout.write(renderEvent(event, { color: true }));
    },
  });

  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  return ok ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `tsforge: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
