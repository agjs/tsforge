import type { ITask } from "../spec/spec.types";
import type { ErrorParser, ErrorSet, IValidateResult } from "../validate";
import { validate } from "../validate";
import type { IAcceptOptions } from "../validate/accept";
import { shellQuote } from "../lib/fs";
import { buildGate } from "./core-gate";
import { makeFileLinter } from "./linter";
import { discoverTestCommand } from "./test-discovery";
import type { FileLinter } from "./types";
import {
  activePackageRoots,
  isWorkspaceContainer,
  owningPackageRoot,
  packageLabel,
  unpackagedCodePaths,
} from "./workspace-root";
import { detectStack } from "../stack-detection";

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

/**
 * Run the auto gate for a workspace container: only packages touched this
 * session. No touches → green no-op. Each package gets its own buildGate +
 * validate in that package's cwd. Touched code outside every package FAILS —
 * there is no config to gate it with, and a silent pass there would be a
 * false green.
 */
export async function runWorkspaceContainerGate(
  sessionCwd: string,
  task: ITask,
  touched: Iterable<string>,
  parse: ErrorParser | undefined,
  opts: IAcceptOptions
): Promise<IWorkspaceGateRun> {
  if (!isWorkspaceContainer(sessionCwd)) {
    throw new Error(
      "runWorkspaceContainerGate: cwd is not a workspace container"
    );
  }

  const ungated = ungatedCodeFailure(sessionCwd, touched);
  const packages = activePackageRoots(sessionCwd, touched);

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

  const fan = await gateEachPackage(packages, task, parse, opts);
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
  opts: IAcceptOptions
): Promise<IFanOut> {
  const outputs: string[] = [];
  const errors: ErrorSet = [];
  const commands: string[] = [];
  const packs = new Set<string>();
  let passed = true;

  for (const pkg of packages) {
    const label = packageLabel(pkg);
    const stack = await detectStack(pkg);
    const testCommand = await discoverTestCommand(pkg);
    const gate = await buildGate(pkg, stack.packs, undefined, {
      includeTests: true,
      testCommand,
    });
    const pkgTask: ITask = { ...task, accept: gate.command };

    // A subshell per package: the command is built for that package's cwd, and
    // `accept` must stay runnable from the container root.
    commands.push(`(cd ${shellQuote(pkg)} && ${gate.command})`);

    for (const pack of stack.packs) {
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
 * linter built for the OWNING package (its own stack packs and eslint config),
 * built once per package and reused. Files under no package report clean —
 * `runWorkspaceContainerGate` fails them instead.
 */
export function makeWorkspaceFileLinter(sessionCwd: string): FileLinter {
  const perPackage = new Map<string, FileLinter>();

  return async (absPath) => {
    const pkg = owningPackageRoot(sessionCwd, absPath);

    if (pkg === null) {
      return [];
    }

    let linter = perPackage.get(pkg);

    if (linter === undefined) {
      const stack = await detectStack(pkg);

      linter = makeFileLinter("core", pkg, stack.packs);
      perPackage.set(pkg, linter);
    }

    return linter(absPath);
  };
}
