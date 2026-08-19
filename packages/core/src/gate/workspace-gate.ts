import { resolve, relative, isAbsolute, join } from "node:path";
import type { ITask } from "../spec/spec.types";
import type {
  ErrorParser,
  ErrorSet,
  IErrorItem,
  IValidateResult,
} from "../validate";
import { validate } from "../validate";
import type { IAcceptOptions } from "../validate/accept";
import { shellQuote } from "../lib/fs";
import {
  capturePackageGatePolicy,
  resolvePackageGate,
  type IPackageGateCaptureOpts,
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
  /** CLI overlays applied when a package policy is first captured. */
  readonly capture?: IPackageGateCaptureOpts;
  /** Package roots (absolute) detected dirty OUTSIDE the tool path (git-status
   *  baseline diff — shell writes, scripts, git apply). Unioned with the
   *  touched-derived set: `touched` only sees edit/create TOOL events, so
   *  without this a `sed -i` change green-skipped the whole gate. */
  readonly extraPackageRoots?: readonly string[];
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
  const touchedPackages = activePackageRoots(sessionCwd, touched);
  // Union git-detected dirty roots with the tool-touched set — ALWAYS, not only
  // when touched is empty: a session that tool-edited app/ but shell-edited
  // api/ must gate both.
  const detectedOnly = (opts.extraPackageRoots ?? []).filter(
    (pkg) => !touchedPackages.includes(pkg)
  );
  const packages = [...touchedPackages, ...detectedOnly].sort();
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

  const fan = await gateEachPackage(
    packages,
    task,
    parse,
    opts,
    policies,
    opts.capture ?? {},
    new Set(detectedOnly)
  );
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
  policies: Map<string, IPackageGatePolicy>,
  capture: IPackageGateCaptureOpts,
  detectedOnly: ReadonlySet<string> = new Set()
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
      policy = await capturePackageGatePolicy(pkg, capture);
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
    const via = detectedOnly.has(pkg)
      ? " (included via git-detected changes — files were written outside the edit tools)"
      : "";

    outputs.push(`── ${label} ──${via}\n${r.output}`.trimEnd());

    if (!r.passed) {
      passed = false;
      // Prefix so app/src/bad.ts and api/src/bad.ts don't collapse to one key.
      errors.push(...r.errors.map((e) => relocatePackageError(label, pkg, e)));
    }
  }

  return { passed, errors, outputs, commands, packs };
}

/** Make package-local diagnostics unique across the workspace fan-out.
 *  ESLint often emits absolute paths — relativize to the package first, then
 *  prefix with the package label (never `app` + `/private/.../app/src/...`). */
export function relocatePackageError(
  packageLabelName: string,
  packageDir: string,
  error: IErrorItem
): IErrorItem {
  if (error.file === undefined || error.file.length === 0) {
    return { ...error, key: `${packageLabelName}:${error.key}` };
  }

  const raw = error.file.replace(/^\.\//u, "");
  const local = isAbsolute(raw)
    ? relative(packageDir, raw).replaceAll("\\", "/")
    : raw;

  // Still outside the package after relativizing — keep the basename under label.
  const safeLocal =
    local.startsWith("..") || isAbsolute(local)
      ? raw.replace(/^.*[/\\]/u, "")
      : local;
  const prefixed = join(packageLabelName, safeLocal).replaceAll("\\", "/");

  return {
    ...error,
    file: prefixed,
    key: error.key.includes(raw)
      ? error.key.replace(raw, prefixed)
      : error.key.includes(safeLocal)
        ? error.key.replace(safeLocal, prefixed)
        : `${prefixed}:${error.key}`,
  };
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
 * linter built for the OWNING package. Rebuilds when packs grow so newly
 * activated frameworks aren't linted under the old ruleset.
 */
export function makeWorkspaceFileLinter(
  sessionCwd: string,
  policies?: Map<string, IPackageGatePolicy>,
  capture?: IPackageGateCaptureOpts
): FileLinter {
  const cache = policies ?? new Map<string, IPackageGatePolicy>();
  const perPackage = new Map<
    string,
    { readonly packsKey: string; readonly lint: FileLinter }
  >();
  const captureOpts = capture ?? {};

  return async (absPath) => {
    const pkg = owningPackageRoot(sessionCwd, absPath);

    if (pkg === null) {
      return [];
    }

    let policy = cache.get(pkg);

    if (policy === undefined) {
      policy = await capturePackageGatePolicy(pkg, captureOpts);
      cache.set(pkg, policy);
    }

    const resolved = await resolvePackageGate(policy);
    const packsKey = resolved.packs.join("\0");
    const cached = perPackage.get(pkg);

    if (cached?.packsKey !== packsKey) {
      perPackage.set(pkg, { packsKey, lint: resolved.lintFile });
    }

    return (await perPackage.get(pkg)?.lint(absPath)) ?? [];
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
