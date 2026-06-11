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

  await ctx.setupWeb(framework);

  return (
    `Scaffolded a ${framework} project (stack + deps installed) and switched to ` +
    "the web gate. Now BUILD it: first write the type contract — each domain's " +
    "`src/<domain>/<domain>.types.ts` (+ `.constants.ts`) — then implement the " +
    "routes/features against those types using @/components/ui. Run the gate when " +
    "done; it confirms the build, types, lint, and a browser render."
  );
}
