import { runArgvCommand } from "../../lib/fs";
import { LOOP_LIMITS } from "../loop.constants";
import { str, reject, type IToolContext } from "./tool-context";

/** A commit SHA: 4–40 hex chars. Anything else for `show` is rejected. */
const SHA_RE = /^[0-9a-fA-F]{4,40}$/;

/** Shell metacharacters / option-injection markers we refuse in free-form `ref`
 *  and `path` args. Everything is passed as a literal argv (no shell), so this is
 *  defense-in-depth against smuggling `--upload-pack=…`-style options or `$()`. */
const UNSAFE = /[;&|`$(){}<>\n\r]/;

function unsafe(value: string): boolean {
  // Trim first: " -x" would otherwise slip past the leading-dash check.
  const trimmed = value.trim();

  return (
    trimmed.length > 0 && (UNSAFE.test(trimmed) || trimmed.startsWith("-"))
  );
}

/** A positive integer arg, or undefined when missing/invalid. */
function intArg(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const v = args[key];

  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

type Built = { argv: string[] } | { error: string };

function buildDiff(
  args: Record<string, unknown>,
  ref: string,
  path: string
): Built {
  const argv = ["git", "diff"];

  if (args.staged === true) {
    argv.push("--staged");
  }

  if (ref.length > 0) {
    argv.push(ref);
  }

  if (path.length > 0) {
    argv.push("--", path);
  }

  return { argv };
}

function buildChangedFiles(ref: string, path: string): Built {
  const argv = ["git", "diff", "--numstat"];

  if (ref.length > 0) {
    argv.push(ref);
  }

  if (path.length > 0) {
    argv.push("--", path);
  }

  return { argv };
}

function buildLog(args: Record<string, unknown>, path: string): Built {
  const max = intArg(args, "max") ?? 15;
  const start = intArg(args, "lineStart");
  const end = intArg(args, "lineEnd");

  if (start !== undefined && end !== undefined && path.length > 0) {
    const [s, e] = start > end ? [end, start] : [start, end];

    return {
      argv: ["git", "log", `-L${s},${e}:${path}`, `--max-count=${max}`],
    };
  }

  const argv = [
    "git",
    "log",
    `--max-count=${max}`,
    "--date=short",
    "--pretty=format:%h %ad %s",
  ];

  if (path.length > 0) {
    argv.push("--", path);
  }

  return { argv };
}

function buildBlame(args: Record<string, unknown>, path: string): Built {
  if (path.length === 0) {
    return { error: "git_context: blame needs a `path`" };
  }

  const start = intArg(args, "lineStart");
  const end = intArg(args, "lineEnd");
  const argv = ["git", "blame", "--date=short"];

  if (start !== undefined && end !== undefined) {
    const [s, e] = start > end ? [end, start] : [start, end];

    argv.push(`-L${s},${e}`);
  }

  argv.push("--", path);

  return { argv };
}

function buildShow(args: Record<string, unknown>): Built {
  const sha = str(args, "sha");

  return SHA_RE.test(sha)
    ? { argv: ["git", "show", "--date=short", sha] }
    : { error: "git_context: show needs a valid `sha` (4–40 hex chars)" };
}

function buildArgv(op: string, args: Record<string, unknown>): Built {
  const ref = str(args, "ref");
  const path = str(args, "path");

  if (unsafe(ref)) {
    return { error: `git_context: unsafe ref '${ref}'` };
  }

  if (unsafe(path)) {
    return { error: `git_context: unsafe path '${path}'` };
  }

  switch (op) {
    case "diff":
      return buildDiff(args, ref, path);
    case "changed_files":
      return buildChangedFiles(ref, path);
    case "log":
      return buildLog(args, path);
    case "blame":
      return buildBlame(args, path);
    case "show":
      return buildShow(args);
    default:
      return {
        error: `git_context: unknown op '${op}' (use diff|changed_files|log|blame|show)`,
      };
  }
}

/**
 * Structured, read-only git introspection — the model's way to scope a review or
 * a fix to what actually changed. Wraps the `git` binary via an explicit argv (NO
 * shell, so model-supplied ref/path/sha can't be expanded or smuggle options); the
 * `op` is a fixed allowlist of read-only subcommands. Output is char-capped
 * (override with `maxChars`). A missing git binary or non-repo degrades to a clear
 * message instead of throwing.
 */
export async function doGit(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const op = str(args, "op");
  const built = buildArgv(op, args);

  if ("error" in built) {
    return reject(ctx, "git_context", built.error);
  }

  const res = await runArgvCommand(
    ctx.cwd,
    built.argv,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );

  ctx.report({ kind: "tool", task: ctx.task, message: `git ${op}` });

  if (res.exitCode === 127) {
    return "git_context: git is not installed or not on PATH";
  }

  const combined = `${res.stdout}${res.stderr}`;

  if (/not a git repository/i.test(combined)) {
    return "git_context: not a git repository (no .git found)";
  }

  // On failure prefer stderr (the real error); fall back to stdout when git
  // wrote partial output there. On success, stdout is the result.
  const failed = res.exitCode !== 0;
  const body = failed && res.stderr.trim().length > 0 ? res.stderr : res.stdout;
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;
  const clipped = body.length > max;
  const out = body.slice(0, max);
  const note = clipped
    ? `\n[truncated ${body.length - max} chars — pass maxChars for more]`
    : "";

  return out.trim().length > 0 ? out + note : `git ${op}: (no output)`;
}
