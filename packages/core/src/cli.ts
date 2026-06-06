#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { runTask, RUN_STATUS, Session } from "./loop";
import {
  PROVIDER_LIMITS,
  OpenAICompatibleProvider,
  PROVIDER_DEFAULTS,
  type IProvider,
} from "./inference";
import { renderEvent, welcomeBanner } from "./render";
import type { ITask } from "./spec";
import type { Reporter } from "./loop";

/**
 * The tsforge CLI — the product surface over the same engine the eval harness
 * uses (see cli-product-direction). Like any agentic CLI: cd into a repo, run it,
 * and talk. The agent reads/runs/edits the whole workspace by default.
 *
 *   tsforge                       # interactive session in the current repo
 *   tsforge --dir ~/app           # ...in another repo
 *   tsforge "fix the build"       # interactive, with that as the first message
 *   tsforge "fix X" --accept "npm test"   # one-shot: drive to green, then exit
 *
 * The eval-only knobs are now OPTIONAL refinements, never required:
 *   --files "<globs>"   narrow the editable scope (default: the whole workspace)
 *   --accept "<cmd>"    a gate that confirms "done" (default: stop when the model
 *                       stops — like any chat agent). With a gate set, tsforge's
 *                       deterministic check enforces correctness; it can't be faked.
 * Slash commands (/help, /clear, /exit) follow the standard harness UX. Provider
 * via TSFORGE_* env.
 */
export interface ICliArgs {
  /** Empty ⇒ interactive REPL; non-empty ⇒ one-shot task. */
  task: string;
  dir: string;
  files: string[];
  accept: string;
}

/** Parse argv (without `bun cli.ts`). Always succeeds — mode is decided in main. */
export function parseArgs(argv: readonly string[]): ICliArgs {
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

  return {
    task: positional.join(" ").trim(),
    dir: isAbsolute(dir) ? dir : join(process.cwd(), dir),
    files,
    accept,
  };
}

// Default editable scope: the whole workspace — like any agentic CLI, the agent
// may edit any file. `--files` only NARROWS this (a safety/eval tripwire); it's
// never required. `**/*` matches top-level and nested paths alike.
const WHOLE_REPO = ["**/*"];

/** Resolve the editable scope: an explicit `--files` narrowing, else the whole repo. */
function scopeOf(args: ICliArgs): string[] {
  return args.files.length > 0 ? args.files : WHOLE_REPO;
}

/** One-shot mode = a task PLUS a gate to drive to green; else interactive. */
export function isOneShot(args: ICliArgs): boolean {
  return args.task.length > 0 && args.accept.length > 0;
}

/** The host:port of an API base URL, for the banner (falls back to the raw url). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function makeProvider(): IProvider {
  return new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
    model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: Number(
      process.env.TSFORGE_MAX_TOKENS ?? String(PROVIDER_LIMITS.maxTokens)
    ),
  });
}

const render: Reporter = (event) => {
  process.stdout.write(renderEvent(event, { color: true }));
};

/** One-shot: drive a single task to green, then exit. */
async function runOnce(args: ICliArgs): Promise<number> {
  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: scopeOf(args),
    context: [],
  };

  const result = await runTask(task, args.dir, makeProvider(), {
    onEvent: render,
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  return ok ? 0 : 1;
}

const HELP = [
  "Commands:",
  "  /help          show this help",
  "  /clear         reset the conversation (keeps the workspace + gate)",
  "  /exit, /quit   leave the session",
  "",
  "Anything else is sent to the agent. It works with its tools; when it stops,",
  'the gate (if set with --accept) confirms "done".',
].join("\n");

/** Interactive REPL: a persistent gate-anchored conversation. */
async function repl(args: ICliArgs): Promise<number> {
  const provider = makeProvider();
  const config = {
    provider,
    cwd: args.dir,
    files: scopeOf(args),
    accept: args.accept,
    report: render,
  };

  let session = await Session.create(config);

  process.stdout.write(
    welcomeBanner({
      model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
      endpoint: hostOf(
        process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl
      ),
    })
  );
  process.stdout.write(
    [
      `  cwd:   ${args.dir}`,
      `  scope: ${args.files.length > 0 ? args.files.join(", ") : "entire workspace"}`,
      `  gate:  ${args.accept.length > 0 ? args.accept : "none (stops when done; --accept to enforce a check)"}`,
      "  /help for commands, /exit to quit",
      "",
    ].join("\n")
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // A positional task given on the command line is sent as the first message.
  if (args.task.length > 0) {
    const first = await session.send(args.task);

    process.stdout.write(`\n[${first.status} · ${first.turns} turn(s)]\n`);
  }

  // Iterate the interface (not question()-in-a-loop) so buffered/piped input is
  // handled as well as interactive TTY input. The body backpressures reads — the
  // next line isn't pulled until the current send/command finishes.
  process.stdout.write("\n› ");

  for await (const raw of rl) {
    const line = raw.trim();

    if (line.length === 0) {
      process.stdout.write("› ");
      continue;
    }

    if (line.startsWith("/")) {
      const cmd = line.slice(1).toLowerCase();

      if (cmd === "exit" || cmd === "quit") {
        break;
      } else if (cmd === "help") {
        process.stdout.write(`${HELP}\n`);
      } else if (cmd === "clear") {
        session = await Session.create(config);
        process.stdout.write("conversation cleared\n");
      } else {
        process.stdout.write(`unknown command: ${line} (try /help)\n`);
      }

      process.stdout.write("\n› ");
      continue;
    }

    const result = await session.send(line);

    process.stdout.write(
      `\n[${result.status} · ${result.turns} turn(s)]\n\n› `
    );
  }

  rl.close();

  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // A positional task with a scope + gate ⇒ one-shot; otherwise interactive.
  return isOneShot(args) ? runOnce(args) : repl(args);
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
