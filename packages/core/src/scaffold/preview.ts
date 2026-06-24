import { answersToPlan } from "./plan";
import type { IScaffoldAnswers, IScaffoldManifest } from "./scaffold.types";

/**
 * Human-readable preview of what a set of answers will produce — shown on the
 * wizard's overview screen (and the headless dry-run) BEFORE anything is applied,
 * so the user sees the consequence of their toggles: the container topology (the
 * 5-vs-20 cost), the secrets they'll need to supply, and any blocking cross-rule
 * violation. Pure; derived entirely from {@link answersToPlan}. Never prints secret
 * values (it only names the required keys).
 */
export function scaffoldPreview(
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers
): string {
  if (answers.archetype === "astro") {
    return [
      "Astro static site (boringstack apps/docs).",
      "Gate: bun run build — no services, no .env, no Docker.",
    ].join("\n");
  }

  const plan = answersToPlan(manifest, answers);
  const lines: string[] = [];

  lines.push(
    `Boots ${String(plan.services.length)} services: ${plan.services.join(", ")}`
  );

  if (plan.requiredSecrets.length > 0) {
    lines.push(
      "",
      `Secrets you must supply (${String(plan.requiredSecrets.length)}):`,
      ...plan.requiredSecrets.map((s) => `  - ${s}`)
    );
  } else {
    lines.push("", "No secrets required for this configuration.");
  }

  if (plan.violations.length > 0) {
    lines.push(
      "",
      "⚠ Invalid — cannot apply until resolved:",
      ...plan.violations.map((v) => `  ✗ ${v}`)
    );
  }

  return lines.join("\n");
}
