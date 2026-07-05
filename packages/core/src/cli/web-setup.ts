/** Web-project bootstrap shared by the REPL and `--web`: scaffold the skeleton,
 *  install deps, and report progress honestly (the model can't build until deps
 *  resolve). */
import { scaffoldWeb, installWebDeps } from "../scaffold/web-scaffold";
import type { WebFramework } from "../web-templates";

export function frameworkLabel(framework: WebFramework): string {
  return framework === "react"
    ? "Vite + React + shadcn/ui + TanStack"
    : "Vite + TypeScript + Tailwind";
}

/** Lay down a stack's skeleton and install its dependencies, reporting progress —
 *  the model can't build until deps resolve. Returns the files actually written and
 *  whether install succeeded so the `scaffold_web` tool can account for the mutation
 *  and tell the model the truth (instead of always claiming "deps installed"). */
export async function setUpWebProject(
  dir: string,
  framework: WebFramework,
  options: { signal?: AbortSignal } = {}
): Promise<{ files: readonly string[]; depsInstalled: boolean }> {
  const files = await scaffoldWeb(dir, framework);

  process.stdout.write(`  ↳ installing ${frameworkLabel(framework)}…\n`);

  const depsInstalled = await installWebDeps(dir, options);

  process.stdout.write(
    depsInstalled
      ? "  ↳ dependencies ready\n"
      : "  ⚠ dependency install failed — run `bun install` yourself\n"
  );

  return { files, depsInstalled };
}
