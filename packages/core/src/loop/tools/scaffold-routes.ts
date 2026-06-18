import { join } from "node:path";
import { writable, normalizeWorkspacePath } from "../../lib/scope";
import { materializeRoutes, asRoutePaths } from "../../web-routes";
import { type IToolContext } from "./tool-context";

/**
 * `scaffold_routes` — materialize ALL of an app's routes as file-based stubs from
 * a model-declared path list, so the route union is complete up front and no
 * `<Link to>` can forward-reference a missing route (the error class that ate ~1/3
 * of multi-route builds). The model owns WHAT (which pages — app-specific); this
 * owns HOW (correct createFileRoute + $param filename mapping). Like scaffold_ui:
 * overwrites stubs idempotently and reports ONE summary event (not per-file
 * `create`s) so the write-guard doesn't re-check the generated shells.
 */
export async function doScaffoldRoutes(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const paths = asRoutePaths(args.routes);

  if (paths.length === 0) {
    return 'scaffold_routes REJECTED: `routes` must be a non-empty array of path strings (e.g. ["/", "/accounts", "/accounts/$accountId"]).';
  }

  const files = materializeRoutes(paths);
  const written: string[] = [];
  const kept: string[] = [];

  for (const [rel, content] of Object.entries(files)) {
    const path = normalizeWorkspacePath(ctx.cwd, rel);

    if (!writable(path, ctx.files)) {
      continue;
    }

    // NEVER overwrite an existing route file — it may already be FILLED with the
    // real page. scaffold_routes is idempotent + additive: it only stubs routes
    // that don't exist yet. (Re-calling it to add new pages used to clobber every
    // already-built page back to a stub → an endless re-fill loop.)
    if (await Bun.file(join(ctx.cwd, path)).exists()) {
      kept.push(path);
      continue;
    }

    await Bun.write(join(ctx.cwd, path), content);
    written.push(path);
  }

  const keptNote =
    kept.length > 0
      ? ` (kept ${String(kept.length)} existing route(s) untouched)`
      : "";

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `scaffold_routes: created ${String(written.length)} new route stub(s)${keptNote}`,
    // Re-gate + change-scope the new stubs so the gate runs (it fails while any
    // stub is unfilled) — WITHOUT write-guarding each generated shell. Empty when
    // nothing new was written, so a no-op call doesn't force a gate run.
    ...(written.length > 0 ? { mutated: written } : {}),
  });

  return (
    `scaffold_routes: created ${String(written.length)} NEW route stub(s)${keptNote}. ` +
    `It is ADDITIVE and safe to call again — it NEVER overwrites a route you've already ` +
    `built, only adds missing ones. New stubs are PLACEHOLDERS (data-tsforge-stub): replace ` +
    `EACH with the real page (its list/detail/form using your types + your own data ` +
    `(seed/constants or a <feature>.hooks.ts) + @/components/ui). The gate FAILS while any ` +
    `stub remains. To FILL a route, EDIT its file ` +
    `directly — do NOT call scaffold_routes again to "reset" it.`
  );
}
