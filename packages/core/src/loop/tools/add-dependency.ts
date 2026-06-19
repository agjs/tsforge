import { join } from "node:path";
import { runArgv } from "../../agent";
import { reject, str, type IToolContext } from "./tool-context";

/** A valid npm package spec: optional @scope/, name, optional @version-range.
 *  Anything else (flags, paths, shell metacharacters) is rejected — the names
 *  are the ONLY untrusted text that reaches the `bun add` argv. The first
 *  character class deliberately excludes `-` so a leading flag like
 *  `-g`/`--registry` can never validate as a name. The version class excludes
 *  shell-redirection chars (`<`/`>`): even though we now spawn an explicit argv
 *  (no shell), keeping them out is defense-in-depth and these range operators
 *  aren't needed for `bun add` (use `^`/`~`/exact). */
const PACKAGE_SPEC_RE =
  /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*(@[a-zA-Z0-9.^~=+-]+)?$/;

/** Parse + validate the space-separated package list; null if any spec is bad. */
export function parsePackageSpecs(packages: string): string[] | null {
  const specs = packages.trim().split(/\s+/).filter(Boolean);

  if (specs.length === 0 || !specs.every((s) => PACKAGE_SPEC_RE.test(s))) {
    return null;
  }

  return specs;
}

/**
 * `add_dependency` — install npm packages with bun. The measured gap: builds
 * dead-ended (or hand-rolled a library badly) whenever a feature needed a dep
 * the scaffold didn't ship. Validation is strict so the model can't smuggle
 * flags or shell syntax; the install runs in the workspace root with the
 * turn's abort signal, like any `run` command.
 */
export async function doAddDependency(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const specs = parsePackageSpecs(str(args, "packages"));

  if (specs === null) {
    return reject(
      ctx,
      "add_dependency",
      "add_dependency: `packages` must be plain npm package names " +
        "(optionally @versioned), space-separated — no flags or paths."
    );
  }

  if (!(await Bun.file(join(ctx.cwd, "package.json")).exists())) {
    return reject(
      ctx,
      "add_dependency",
      "add_dependency: no package.json in the workspace — this isn't an npm " +
        "project (scaffold or init one first)."
    );
  }

  const dev = args.dev === true;
  const argv = ["bun", "add", ...(dev ? ["-d"] : []), ...specs];

  ctx.report({ kind: "tool", task: ctx.task, message: `↳ ${argv.join(" ")}` });

  const res = await runArgv(
    ctx.cwd,
    argv,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );

  if (res.exitCode !== 0) {
    return `add_dependency failed (exit ${String(res.exitCode)}):\n${res.stdout}${res.stderr}`;
  }

  // The install rewrote package.json (+ lockfile) — re-gate so the supply-chain
  // meta-rules re-check it. Accounting-only (no write-guard); success path only.
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `package.json updated (${specs.length} dep(s))`,
    mutated: ["package.json"],
  });

  return `installed ${specs.join(", ")}${dev ? " (dev)" : ""} — import and use them now.`;
}
