import { resolve, relative, isAbsolute } from "node:path";
import type { ITask } from "../spec/spec.types";
import type { ErrorParser, ErrorSet, IValidateResult } from "../validate";
import { validate } from "../validate";
import type { IAcceptOptions } from "../validate/accept";
import { shellQuote } from "../lib/fs";
import {
  capturePackageGatePolicy,
  resolvePackageGate,
  type IPackageGatePolicy,
} from "./package-gate-policy";
import {
  activePackageRoots,
  isWorkspaceContainer,
  owningPackageRoot,
  packageLabel,
  unpackagedCodePaths,
} from "./workspace-root";
import type { FileLinter } from "./types";

/** Error key for touched code that no package can gate. */
const UNGATED_KEY = "workspace-ungated-code";

export interface IWorkspaceGateRun {
  readonly result: IValidateResult;
  /** EXECUTABLE acceptance command for the touched packages — `task.accept` is
   *  persisted and re-run verbatim (`--continue`, `/clear` rebuild), so it must
   *  never hold a display label. `true` when nothing needs gating. */
  readonly accept: string;
  /** Union of the rule packs the per-package gates enforced — the failure
   *  identity the model is shown must name the packs that actually ran. */
  readonly packs: readonly string[];
  /** Which packages ran, for the gate identity ("app + api"; empty when none). */
  readonly label: string;
}

export interface IWorkspaceGateOpts extends IAcceptOptions {
  /** Session-scoped policy cache — frozen test command + monotonic packs. */
  readonly policies?: Map<string, IPackageGatePolicy>;
}

/**
 * Run the auto gate for a workspace container: only packages touched this
 * session. No touches → green no-op. Each package gets its own buildGate +
 * validate in that package's cwd (full config policy). Touched code outside
 * every package FAILS — there is no config to gate it with, and a silent pass
 * there would be a false green.
 */
export async function runWorkspaceContainerGate(
  sessionCwd: string,
  task: ITask,
  touched: Iterable<string>,
  parse: ErrorParser | undefined,
  opts: IWorkspaceGateOpts
): Promise<IWorkspaceGateRun> {
  if (!isWorkspaceContainer(sessionCwd)) {
    throw new Error(
      "runWorkspaceContainerGate: cwd is not a workspace container"
    );
  }

  const ungated = ungatedCodeFailure(sessionCwd, touched);
  const packages = activePackageRoots(sessionCwd, touched);
  const policies = opts.policies ?? new Map<string, IPackageGatePolicy>();

  if (packages.length === 0) {
    return {
      result: {
        passed: ungated === null,
        errors: ungated?.errors ?? [],
        output:
          ungated?.output ??
          "workspace container: no package edited — gate skipped (docs/root-only)\n",
      },
      accept: "true",
      packs: [],
      label: "",
    };
  }

  const fan = await gateEachPackage(packages, task, parse, opts, policies);
  const sections =
    ungated === null ? fan.outputs : [...fan.outputs, ungated.output];

  return {
    result: {
      passed: fan.passed && ungated === null,
      errors: [...fan.errors, ...(ungated?.errors ?? [])],
      output: `${sections.join("\n\n")}\n`,
    },
    accept: fan.commands.join(" && "),
    packs: [...fan.packs].sort(),
    label: packages.map((pkg) => packageLabel(pkg)).join(" + "),
  };
}

interface IFanOut {
  readonly passed: boolean;
  readonly errors: ErrorSet;
  readonly outputs: string[];
  readonly commands: string[];
  readonly packs: Set<string>;
}

/** Gate every touched package in its OWN cwd, keeping going after a failure so
 *  the model sees every package's errors in one pass. */
async function gateEachPackage(
  packages: readonly string[],
  task: ITask,
  parse: ErrorParser | undefined,
  opts: IWorkspaceGateOpts,
  policies: Map<string, IPackageGatePolicy>
): Promise<IFanOut> {
  const outputs: string[] = [];
  const errors: ErrorSet = [];
  const commands: string[] = [];
  const packs = new Set<string>();
  let passed = true;

  for (const pkg of packages) {
    const label = packageLabel(pkg);
    let policy = policies.get(pkg);

    if (policy === undefined) {
      policy = await capturePackageGatePolicy(pkg);
      policies.set(pkg, policy);
    }

    const resolved = await resolvePackageGate(policy);
    const pkgTask: ITask = { ...task, accept: resolved.gate.command };

    commands.push(`(cd ${shellQuote(pkg)} && ${resolved.gate.command})`);

    for (const pack of resolved.packs) {
      packs.add(pack);
    }

    opts.onChunk?.(`\ngate → ${label}\n`);

    const r = await validate(pkgTask, pkg, parse, opts);

    outputs.push(`── ${label} ──\n${r.output}`.trimEnd());

    if (!r.passed) {
      passed = false;
      errors.push(...r.errors);
    }
  }

  return { passed, errors, outputs, commands, packs };
}

/** Gate failure for touched code that belongs to no package, or null when none. */
function ungatedCodeFailure(
  sessionCwd: string,
  touched: Iterable<string>
): { readonly errors: ErrorSet; readonly output: string } | null {
  const orphans = unpackagedCodePaths(sessionCwd, touched);

  if (orphans.length === 0) {
    return null;
  }

  const list = orphans.join(", ");
  const message =
    `${list} — code outside every package in this workspace root, so no gate ` +
    `can typecheck or lint it. Move it into one of the existing packages, or ` +
    `give its directory a package.json (+ tsconfig) so it becomes one.`;

  return {
    errors: orphans.map((file) => ({ key: UNGATED_KEY, file, message })),
    output: `── ungated code ──\n${message}\n`,
  };
}

/**
 * Per-write lint moat for a workspace container: routes each written file to a
 * linter built for the OWNING package (full policy packs/overrides/conventions),
 * built once per package and reused.
 */
export function makeWorkspaceFileLinter(
  sessionCwd: string,
  policies?: Map<string, IPackageGatePolicy>
): FileLinter {
  const cache = policies ?? new Map<string, IPackageGatePolicy>();
  const perPackage = new Map<string, FileLinter>();

  return async (absPath) => {
    const pkg = owningPackageRoot(sessionCwd, absPath);

    if (pkg === null) {
      return [];
    }

    let linter = perPackage.get(pkg);

    if (linter === undefined) {
      let policy = cache.get(pkg);

      if (policy === undefined) {
        policy = await capturePackageGatePolicy(pkg);
        cache.set(pkg, policy);
      }

      const resolved = await resolvePackageGate(policy);

      linter = resolved.lintFile;
      perPackage.set(pkg, linter);
    }

    return linter(absPath);
  };
}

/**
 * Map session-relative touched paths to package-relative paths for meta-rules
 * under one child package.
 */
export function packageRelativeTouched(
  sessionCwd: string,
  pkgAbs: string,
  touched: Iterable<string>
): string[] {
  const out: string[] = [];

  for (const path of touched) {
    const abs = isAbsolute(path) ? path : resolve(sessionCwd, path);

    if (owningPackageRoot(sessionCwd, abs) !== pkgAbs) {
      continue;
    }

    out.push(relative(pkgAbs, abs).replaceAll("\\", "/"));
  }

  return out;
}
