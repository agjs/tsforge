import type { ITask } from "../spec/spec.types";
import type { ErrorParser, IValidateResult } from "../validate";
import { validate } from "../validate";
import type { IAcceptOptions } from "../validate/accept";
import { buildGate } from "./core-gate";
import { discoverTestCommand } from "./test-discovery";
import {
  activePackageRoots,
  isWorkspaceContainer,
  packageLabel,
} from "./workspace-root";
import { detectStack } from "../stack-detection";

/**
 * Run the auto gate for a workspace container: only packages touched this
 * session. No touches → green no-op. Each package gets its own buildGate +
 * validate in that package's cwd.
 */
export async function runWorkspaceContainerGate(
  sessionCwd: string,
  task: ITask,
  touched: Iterable<string>,
  parse: ErrorParser | undefined,
  opts: IAcceptOptions
): Promise<{ result: IValidateResult; acceptSummary: string }> {
  if (!isWorkspaceContainer(sessionCwd)) {
    throw new Error(
      "runWorkspaceContainerGate: cwd is not a workspace container"
    );
  }

  const packages = activePackageRoots(sessionCwd, touched);

  if (packages.length === 0) {
    const acceptSummary = "true";
    const result: IValidateResult = {
      passed: true,
      errors: [],
      output:
        "workspace container: no package edited — gate skipped (docs/root-only)\n",
    };

    return { result, acceptSummary };
  }

  const outputs: string[] = [];
  const errors: IValidateResult["errors"] = [];
  const labels: string[] = [];
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

    labels.push(`${label}: ${gate.label}`);
    opts.onChunk?.(`\ngate → ${label}\n`);

    const r = await validate(pkgTask, pkg, parse, opts);

    outputs.push(`── ${label} ──\n${r.output}`.trimEnd());

    if (!r.passed) {
      passed = false;
      errors.push(...r.errors);
      // Keep going so the model sees failures in every touched package.
    }
  }

  return {
    result: {
      passed,
      errors,
      output: outputs.join("\n\n") + "\n",
    },
    acceptSummary: labels.join(" && "),
  };
}
