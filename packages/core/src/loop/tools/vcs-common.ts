import { runArgvCommand } from "../../lib/fs";

/** Shell metacharacters / option-injection markers refused in free-form args
 *  (branch names, refs, PR selectors). Everything is passed as a literal argv
 *  (no shell), so this is defense-in-depth against smuggling `--flag`-style
 *  options or `$()`. Mirrors git-ops.ts's guard. */
export const UNSAFE = /[;&|`$(){}<>\n\r]/u;

/** True when a model-supplied value is unsafe to pass as an argv token — has a
 *  shell metacharacter, or leads with `-` (would be read as an option). */
export function unsafe(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.length > 0 && (UNSAFE.test(trimmed) || trimmed.startsWith("-"))
  );
}

/** A positive integer arg, or undefined when missing/invalid. */
export function intArg(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const v = args[key];

  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** A string[] arg (each element a string), else undefined. */
export function strArrayArg(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const v = args[key];

  return Array.isArray(v) && v.every((e) => typeof e === "string")
    ? [...v]
    : undefined;
}

/** First value with non-whitespace content, else the last (a guaranteed
 *  fallback). Replaces `a || b || fallback` chains the strict-boolean lint bans. */
export function pick(...vals: string[]): string {
  for (const v of vals) {
    if (v.trim().length > 0) {
      return v;
    }
  }

  return vals[vals.length - 1] ?? "";
}

/** Cap output from the HEAD, appending a truncation note when clipped. */
export function capHead(body: string, max: number): string {
  if (body.length <= max) {
    return body;
  }

  return `${body.slice(0, max)}\n[truncated ${String(
    body.length - max
  )} chars — pass maxChars for more]`;
}

/** Cap output from the TAIL (for CI logs — the failure is at the end). */
export function capTail(body: string, max: number): string {
  if (body.length <= max) {
    return body;
  }

  return `[truncated ${String(body.length - max)} earlier chars — showing the tail]\n${body.slice(
    body.length - max
  )}`;
}

/** Injectable command runner so the git/GitHub handlers are hermetically
 *  testable with a canned runner (the IImageToolDeps pattern). Defaults to the
 *  real argv spawner (no shell, missing binary → exit 127, never throws). */
export type VcsRunner = typeof runArgvCommand;

export interface IVcsDeps {
  run: VcsRunner;
}

export const DEFAULT_VCS_DEPS: IVcsDeps = { run: runArgvCommand };

/** Argv-injection guard result shared by the op builders. */
export type Built = { argv: string[] } | { error: string };
