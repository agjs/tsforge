/** Shared CLI chrome helpers: scope labels and the plan-mode footer chip. */
import {
  STYLE,
  paint,
  roleCardCols,
  filledRoleBadge,
  roleHairline,
  roleBadgeCols,
} from "../render";

/** Human label for an editable scope (the whole-repo default reads nicer). */
export function scopeLabel(files: string[]): string {
  return files.length === 1 && files[0] === "**/*"
    ? "entire workspace"
    : files.join(", ");
}

/** Hollow orange chip around the approve keyword (inline outlined pill). */
function approveChip(): string {
  return (
    paint("[", STYLE.plan, true) +
    paint(" APPROVE ", STYLE.plan + STYLE.bold, true) +
    paint("]", STYLE.plan, true)
  );
}

/** The post-turn plan-mode footer — filled PLAN badge + orange rail, matching
 *  the agent-console plan strip. `ready` = plan proposed (nudge build);
 *  otherwise still exploring. */
export function planHint(ready: boolean, columns?: number): string {
  const cols = roleCardCols(columns);
  const badge = filledRoleBadge("PLAN", true);
  const top =
    badge + roleHairline(cols, STYLE.plan, true, "", roleBadgeCols(badge));
  // Thin rail + inner pad — matches USER/AGENT breathing room.
  const gutter = paint("│", STYLE.plan, true) + "  ";
  const action = ready ? "TO BUILD" : "TO CONTINUE";
  const body = [
    paint("REPLY TO REFINE", STYLE.plan + STYLE.bold, true),
    paint("  |  ", STYLE.plan, true),
    paint("TYPE ", STYLE.plan, true),
    approveChip(),
    paint(` ${action}`, STYLE.plan, true),
  ].join("");

  return `${top}\n${gutter}\n${gutter}${body}`;
}
