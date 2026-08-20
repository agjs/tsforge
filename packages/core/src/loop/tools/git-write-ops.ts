import { str, reject, type IToolContext } from "./tool-context";
import {
  unsafe,
  strArrayArg,
  capHead,
  pick,
  DEFAULT_VCS_DEPS,
  type IVcsDeps,
  type Built,
} from "./vcs-common";
import { LOOP_LIMITS } from "../loop.constants";

/** The github capability = the user's consent to git/GitHub writes. Absent it,
 *  even a salvaged/forced call must fail closed (belt to the advertisement gate). */
const CAPABILITY_OFF =
  "the GitHub capability is off — install and authenticate the gh CLI " +
  "(`gh auth login`) and ensure TSFORGE_NO_GITHUB is unset.";

function buildBranch(name: string): Built {
  if (name.length === 0 || unsafe(name)) {
    return { error: "git_write branch: needs a safe `name`" };
  }

  return { argv: ["git", "switch", "-c", name] };
}

function buildCheckout(name: string, ref: string): Built {
  const target = name.length > 0 ? name : ref;

  if (target.length === 0 || unsafe(target)) {
    return { error: "git_write checkout: needs a safe `name` or `ref`" };
  }

  return { argv: ["git", "switch", target] };
}

function buildCommit(args: Record<string, unknown>, message: string): Built {
  if (message.trim().length === 0) {
    return { error: "git_write commit: needs a `message`" };
  }

  const stageAll = args.all === true;
  const paths = strArrayArg(args, "paths") ?? [];

  if (!stageAll && paths.length === 0) {
    return {
      error: "git_write commit: pass `paths` to stage, or set `all: true`",
    };
  }

  if (paths.some(unsafe)) {
    return { error: "git_write commit: an unsafe path in `paths`" };
  }

  // Stage then commit as ONE shell-free sequence would need two spawns; we run
  // the stage inside the handler (below) and return only the commit argv here.
  // `message` is a single argv token after -m, so leading dashes / newlines
  // (multi-line messages) are safe without the `unsafe` guard.
  return { argv: ["git", "commit", "-m", message] };
}

function stageArgv(args: Record<string, unknown>): string[] {
  if (args.all === true) {
    return ["git", "add", "-A"];
  }

  const paths = strArrayArg(args, "paths") ?? [];

  return ["git", "add", "--", ...paths];
}

function buildPush(args: Record<string, unknown>): Built {
  // `-u origin HEAD` sets the upstream to a same-named remote branch on the
  // first push; plain `git push` otherwise. HEAD avoids needing the branch name.
  return {
    argv:
      args.setUpstream === true
        ? ["git", "push", "-u", "origin", "HEAD"]
        : ["git", "push"],
  };
}

/**
 * Local git WRITE — commit/branch/checkout/push via the git binary (explicit
 * argv, no shell). Gated by the `github` capability (consent) and the vcs_write
 * policy kind (denied in plan/ci/dontAsk). Deliberately supports NO force-push,
 * rebase, amend, reset, or branch deletion. Never throws; a missing git binary
 * or a git error degrades to a clear string.
 */
export async function doGitWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IVcsDeps = DEFAULT_VCS_DEPS
): Promise<string> {
  if (ctx.github !== true) {
    return reject(ctx, "git_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const message = str(args, "message");
  let built: Built;

  switch (op) {
    case "branch":
      built = buildBranch(str(args, "name"));
      break;
    case "checkout":
      built = buildCheckout(str(args, "name"), str(args, "ref"));
      break;
    case "commit":
      built = buildCommit(args, message);
      break;
    case "push":
      built = buildPush(args);
      break;
    default:
      built = {
        error: `git_write: unknown op '${op}' (use branch|checkout|commit|push)`,
      };
  }

  if ("error" in built) {
    return reject(ctx, "git_write", built.error);
  }

  const signalOpt = ctx.signal === undefined ? {} : { signal: ctx.signal };

  // commit stages first (add), then commits — abort if the stage fails.
  if (op === "commit") {
    const staged = await deps.run(ctx.cwd, stageArgv(args), signalOpt);

    if (staged.exitCode === 127) {
      return "git_write: git is not installed or not on PATH";
    }

    if (staged.exitCode !== 0) {
      return reject(
        ctx,
        "git_write",
        `staging failed: ${pick(staged.stderr, staged.stdout).slice(0, 400)}`
      );
    }
  }

  const res = await deps.run(ctx.cwd, built.argv, signalOpt);

  ctx.report({ kind: "tool", task: ctx.task, message: `git ${op}` });

  if (res.exitCode === 127) {
    return "git_write: git is not installed or not on PATH";
  }

  const combined = `${res.stdout}${res.stderr}`;

  if (/not a git repository/i.test(combined)) {
    return "git_write: not a git repository (no .git found)";
  }

  const body = res.exitCode !== 0 ? combined : pick(res.stdout, combined);
  const capped = capHead(body, LOOP_LIMITS.maxToolOutputChars);

  if (res.exitCode !== 0) {
    return `git ${op} failed:\n${capped.trim()}`;
  }

  return capped.trim().length > 0 ? capped : `git ${op}: done`;
}
