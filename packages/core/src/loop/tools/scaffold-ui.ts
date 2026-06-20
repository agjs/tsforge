import { writable, normalizeWorkspacePath } from "../../lib/scope";
import { writeFilesOrRollback, type IWriteFile } from "../../lib/fs";
import {
  materializeComponents,
  asThemeName,
  asComponentNames,
  COMPONENT_NAMES,
  THEME_NAMES,
} from "../../web-components";
import { reject, type IToolContext } from "./tool-context";

/**
 * `scaffold_ui` — materialize tested, THEMED UI primitives so the model never
 * authors (or re-authors) a button/card/input/etc. Writes `src/index.css` (the
 * vibe's design-token block) + the requested `src/components/ui/*.tsx` primitives
 * with the theme's per-component classes baked in. Overwrites (re-theming is
 * idempotent). Reports ONE summary event — deliberately NOT per-file `create`
 * events, so the write-guard doesn't re-check known-good vendored files.
 *
 * The writes are ATOMIC (writeFilesOrRollback): either every primitive lands and
 * we emit `mutated` once, or none does and we reject — never a half-written set
 * with no re-gate (the partial-mutation contract break the harness review found).
 */
export async function doScaffoldUi(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const theme = asThemeName(args.theme);

  if (theme === undefined) {
    return `scaffold_ui REJECTED: \`theme\` must be one of: ${THEME_NAMES.join(", ")}.`;
  }

  const components = asComponentNames(args.components);

  if (components.length === 0) {
    return `scaffold_ui REJECTED: \`components\` must be a non-empty array from: ${COMPONENT_NAMES.join(", ")}.`;
  }

  // Plan the writes (scope check only): this tool materializes the generated UI
  // primitives, so it just needs each within the editable scope.
  const pending: IWriteFile[] = [];

  for (const [rel, content] of Object.entries(
    materializeComponents(theme, components)
  )) {
    const path = normalizeWorkspacePath(ctx.cwd, rel);

    if (writable(path, ctx.files)) {
      pending.push({ path, content });
    }
  }

  // Nothing in scope → reject honestly; do NOT tell the model to import primitives
  // from @/components/ui that were never written.
  if (pending.length === 0) {
    return reject(
      ctx,
      "scaffold_ui",
      "no UI primitives are within the editable scope (`--files`) — widen the scope, or compose the existing components instead."
    );
  }

  const result = await writeFilesOrRollback(ctx.cwd, pending);

  if (!result.ok) {
    return reject(
      ctx,
      "scaffold_ui",
      `could not write the themed files (${result.reason}) — disk left unchanged.`
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `scaffold_ui: wrote ${String(result.written.length)} themed file(s) [${theme}] — ${components.join(", ")}`,
    // Re-gate after mutating the workspace — without write-guarding each generated
    // (vendored) primitive. Emitted ONLY after a full, successful batch.
    mutated: result.written,
  });

  return (
    `scaffold_ui: wrote ${String(result.written.length)} file(s) with the "${theme}" theme ` +
    `(${result.written.join(", ")}). Import these from @/components/ui (e.g. \`import { Button } ` +
    `from "@/components/ui/button"\`) and COMPOSE them — do NOT re-create any primitive ` +
    `or edit the files under src/components/ui.`
  );
}
