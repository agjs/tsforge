import { join } from "node:path";
import { WEB_TEMPLATES, type WebFramework } from "../web-templates";
import { runArgvCommand } from "../lib/fs/process";

/** Hard ceiling for `bun install` during web scaffolding (5 min) — long enough for
 *  a cold registry, short enough that a wedged install can't hang the session. */
const INSTALL_TIMEOUT_MS = 300_000;

/** Lay down a stack's opinionated skeleton (non-destructive — only missing files).
 *  Dependency install is separate (`installWebDeps`) so this stays pure + fast +
 *  offline-testable. Returns the paths it ACTUALLY wrote (skips files already on
 *  disk) so the caller can report them as a mutation and re-gate. */
export async function scaffoldWeb(
  cwd: string,
  framework: WebFramework
): Promise<readonly string[]> {
  const written: string[] = [];

  for (const [path, content] of Object.entries(
    WEB_TEMPLATES[framework].files
  )) {
    if (await ensureFile(cwd, path, content)) {
      written.push(path);
    }
  }

  return written;
}

/**
 * How a build turn must behave — prepended to every stack's guidance. The base
 * CLI prompt is conversational ("reply with the code") and carries the CORE
 * harness's TS house-rules (I-prefixed interfaces, no `as`). Both are WRONG for a
 * web build: it must write files via tools, and a Vite/React app's gate uses the
 * web lint config (no I-prefix, `as const` allowed). This block overrides both,
 * so the model writes conforming code up front instead of writing idiomatic code
 * and then "correcting" it toward rules the web gate never enforces.
 */
const BUILD_PREAMBLE = [
  "You are BUILDING this app. You produce files by CALLING TOOLS, not by writing",
  "them in your reply: a chat message is never saved to disk and cannot run.",
  "Call `create` once per file (relative path + full contents), ONE file per call,",
  "starting with the first file NOW — do not pre-write everything in prose. After",
  "you stop, the gate builds the app and reports what to fix; then edit and",
  "continue until it passes. Never paste file contents into your message.",
  "",
  "TYPE STYLE — the gate checks these; write them this way the FIRST time (the",
  "gate rejects code that breaks them, and fixing after costs extra turns):",
  "  • Interfaces are BARE PascalCase: `interface Issue`, `interface ButtonProps`",
  "    — the React/shadcn/TanStack ecosystem style. Do NOT `I`-prefix them",
  "    (no `IIssue` / `IButtonProps`). Type ALIASES (`type Status =`) are bare too.",
  "  • `as const` IS allowed and PREFERRED for literal data and registries (e.g.",
  "    `const STATUS = {...} as const`). Still forbidden: `any`, value-changing",
  "    `as` casts, non-null `!`. Use `===`, never `var`.",
  "  • REGISTRIES (the #1 source of type errors): for an `as const` object, DERIVE",
  "    its types — `type Status = keyof typeof STATUSES`, `type StatusInfo =",
  "    (typeof STATUSES)[Status]`. Do NOT declare a separate interface the object",
  "    must match (its `readonly`/literal types won't assign → a wall of TS2322).",
  "    To VALIDATE a registry's shape, append `satisfies` — `const STATUSES = {...}",
  "    as const satisfies Record<string, StatusInfo>` — it checks the shape while",
  "    keeping the literals, and is NOT an `as` cast (allowed). Need a typed key",
  "    array? `Object.keys(x)` is `string[]`; do NOT cast it — make the array the",
  "    source (`const STATUS_KEYS = [...] as const; type Status = (typeof",
  "    STATUS_KEYS)[number]`) and build the registry from it.",
  "",
  "Write it RIGHT the first time — these are the gate's hard rules; code that",
  "breaks them is rejected and costs you extra turns. The fixes are not optional",
  "polish, they are how you write the line:",
  "  • No `x as Foo`. Narrow instead: `if (!(x instanceof Foo)) return;` or a type",
  "    guard, or type the value at its source. For event targets, check the type.",
  "  • SEED/DATA arrays: an UNANNOTATED literal widens (`priority: 'high'` becomes",
  "    `string`), so it won't fit `Thing[]` and you CANNOT cast it (`as` is banned).",
  "    Always pin the type ONE of two ways, then write PLAIN literals (no per-field",
  "    `as`): annotate — `const SEED: readonly Thing[] = [...]` — OR append",
  "    `satisfies` — `const SEED = [...] satisfies readonly Thing[]` (also flags a",
  "    WRONG enum value, e.g. a `priority` not in the union). A literal that's a member",
  "    of the union is already assignable; never write `'high' as Priority`.",
  "  • No `arr[i]!` / `obj.maybe!`. Guard: `const v = arr[i]; if (v === undefined)",
  "    return;` — array/Map index access is `T | undefined` here.",
  "  • No `any`. Use `unknown` + a narrow, or write the real type.",
  "  • Type every function parameter and every `useState`/`useRef` generic.",
  "",
  "Work directly — do NOT restate the task, announce a plan, or narrate progress",
  "between steps ('The user wants me to…', 'I was in the middle of…', 'Now let me…').",
  "That text is wasted. Emit the next tool call.",
  "",
  "NO COMMENTS in the code you write. A comment is generated text that costs you",
  "time, and these add nothing: file-header banners that restate the filename,",
  "decorative section dividers, and lines that restate the code or narrate where a",
  "symbol is defined. Write self-explanatory names instead. The ONLY allowed comment",
  "explains a non-obvious WHY the code cannot — most files need none. No JSDoc.",
].join("\n");

/** The system-prompt guidance for a stack (build framing + structure/conventions). */
export function webGuidance(framework: WebFramework): string {
  return `${BUILD_PREAMBLE}\n\n${WEB_TEMPLATES[framework].guidance}`;
}

/** Install the scaffold's dependencies (react/vite/tailwind/…) with bun, streaming
 *  progress to the terminal. Required before the gate's tsc + vite build can run.
 *  Skipped when deps are already present. Returns false on a failed/timed-out
 *  install. Routes through the shared `runArgvCommand` so the install honours the
 *  same cancellation + kill-timeout as every other harness command (a wedged
 *  registry can't hang the session forever). */
export async function installWebDeps(
  cwd: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<boolean> {
  if (await Bun.file(join(cwd, "node_modules", ".bin", "vite")).exists()) {
    return true;
  }

  const { signal, timeoutMs = INSTALL_TIMEOUT_MS } = opts;
  const run = await runArgvCommand(cwd, ["bun", "install"], {
    timeoutMs,
    onChunk: (text) => process.stdout.write(text),
    ...(signal === undefined ? {} : { signal }),
  });

  return run.exitCode === 0 && !run.timedOut;
}

/** Write `content` to `name` only if it doesn't already exist. Returns true when
 *  it actually wrote (so the caller can account for the mutation). */
async function ensureFile(
  cwd: string,
  name: string,
  content: string
): Promise<boolean> {
  const file = Bun.file(join(cwd, name));

  if (await file.exists()) {
    return false;
  }

  await Bun.write(file, content);

  return true;
}
