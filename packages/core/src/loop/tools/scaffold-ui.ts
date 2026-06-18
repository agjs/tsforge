import { join } from "node:path";
import { writable, normalizeWorkspacePath } from "../../lib/scope";
import {
  materializeComponents,
  asThemeName,
  asComponentNames,
  COMPONENT_NAMES,
  THEME_NAMES,
} from "../../web-components";
import { type IToolContext } from "./tool-context";

/**
 * `scaffold_ui` — materialize tested, THEMED UI primitives so the model never
 * authors (or re-authors) a button/card/input/etc. Writes `src/index.css` (the
 * vibe's design-token block) + the requested `src/components/ui/*.tsx` primitives
 * with the theme's per-component classes baked in. Overwrites (re-theming is
 * idempotent). Reports ONE summary event — deliberately NOT per-file `create`
 * events, so the write-guard doesn't re-check known-good vendored files.
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

  const files = materializeComponents(theme, components);
  const written: string[] = [];

  for (const [rel, content] of Object.entries(files)) {
    const path = normalizeWorkspacePath(ctx.cwd, rel);

    // Scope check only — deliberately NOT the vendored guard. This tool's JOB is to
    // materialize the generated UI primitives; gating it on `isVendored` would refuse
    // the very files it owns if the vendored set ever covered them. (edit/create DO
    // reject vendored paths — there the model must not rewrite a generated shell.)
    if (!writable(path, ctx.files)) {
      continue;
    }

    await Bun.write(join(ctx.cwd, path), content);
    written.push(path);
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `scaffold_ui: wrote ${String(written.length)} themed file(s) [${theme}] — ${components.join(", ")}`,
    // Re-gate after mutating the workspace — without write-guarding each generated
    // (vendored) primitive. Empty when nothing was written.
    ...(written.length > 0 ? { mutated: written } : {}),
  });

  return (
    `scaffold_ui: wrote ${String(written.length)} file(s) with the "${theme}" theme ` +
    `(${written.join(", ")}). Import these from @/components/ui (e.g. \`import { Button } ` +
    `from "@/components/ui/button"\`) and COMPOSE them — do NOT re-create any primitive ` +
    `or edit the files under src/components/ui.`
  );
}
