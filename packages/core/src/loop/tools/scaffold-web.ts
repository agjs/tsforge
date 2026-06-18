import { str, type IToolContext } from "./tool-context";

/**
 * `scaffold_web` — the AGENT's decision to turn this workspace into a from-scratch
 * web app. It calls this ONLY when the request is "build a web app/UI"; for a
 * question, a CLI script, or editing existing code it just does the work. This
 * replaces the old up-front classifier (which mis-fired — e.g. "render a table in
 * the CLI" was scaffolded as a Vite app). The host (interactive CLI) supplies
 * `ctx.setupWeb`, which scaffolds the stack + deps and switches the session to the
 * web gate/guidance; here we just invoke it and tell the model how to proceed.
 */
export async function doScaffoldWeb(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  if (ctx.setupWeb === undefined) {
    return (
      "scaffold_web is unavailable here — this workspace isn't set up for " +
      "interactive scaffolding. Build directly against the existing project."
    );
  }

  const requested = str(args, "framework").toLowerCase();
  const framework = requested === "vanilla" ? "vanilla" : "react";

  let result: { files: readonly string[]; depsInstalled: boolean };

  try {
    result = await ctx.setupWeb(framework);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return `scaffold_web FAILED: ${message}. The workspace was not set up — fix the cause or build against the existing project.`;
  }

  // Report the scaffold's writes so the loop re-gates the change (without per-file
  // write-guarding these generated/vendored shells). Mirror scaffold_ui/_routes:
  // emit `mutated` only when something was actually written.
  if (result.files.length > 0) {
    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `scaffold_web: wrote ${String(result.files.length)} ${framework} file(s)`,
      mutated: result.files,
    });
  }

  const next =
    "Now BUILD it: first write the type contract — each domain's " +
    "`src/<domain>/<domain>.types.ts` (+ `.constants.ts`) — then implement the " +
    "routes/features against those types using @/components/ui.";

  // Tell the model the TRUTH about install: a failed install means the build gate
  // (vite build / tsc) cannot run yet, so it must not assume a green path.
  return result.depsInstalled
    ? `Scaffolded a ${framework} project (stack + deps installed) and switched to ` +
        `the web gate. ${next} Run the gate when done; it confirms the build, ` +
        "types, lint, and a browser render."
    : `Scaffolded a ${framework} project and switched to the web gate, but ` +
        "DEPENDENCY INSTALL FAILED — `node_modules` is incomplete, so the build " +
        "gate (vite build / tsc) cannot pass yet. Run `bun install` (via the `run` " +
        `tool) and confirm it succeeds BEFORE relying on the gate. ${next}`;
}
