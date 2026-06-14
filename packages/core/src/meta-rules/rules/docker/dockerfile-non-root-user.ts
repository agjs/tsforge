import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { dockerInstructionLines } from "./utils";

/**
 * A Dockerfile must drop privileges with a non-root `USER` instruction. Running
 * the container process as root is the default and a standard container-escape
 * amplifier; a single `USER app` (after install steps) closes it.
 */
const ROOT_USERS = new Set(["root", "0", "0:0"]);

/** The user name/uid from a `USER` arg (`USER node` / `USER node:node`). */
function userName(args: string): string {
  return args.trim().toLowerCase();
}

export const dockerfileNonRootUserRule: IMetaRule = {
  id: "dockerfile-non-root-user",
  category: "container",
  description:
    "Dockerfiles must declare a non-root USER so the container process does not run as root.",
  severity: "error",
  run(ctx) {
    const violations: IMetaRuleViolation[] = [];
    const lines = dockerInstructionLines(ctx);
    const byFile = new Map<string, boolean>();

    // Seed every READABLE Dockerfile as "no non-root USER seen yet" (readFile is
    // cached, so this does not re-hit disk).
    for (const file of ctx.dockerfiles) {
      if (ctx.readFile(file) !== null) {
        byFile.set(file, false);
      }
    }

    for (const line of lines) {
      if (line.instruction !== "USER") {
        continue;
      }

      if (!ROOT_USERS.has(userName(line.args))) {
        byFile.set(line.file, true);
      }
    }

    for (const [file, hasNonRoot] of byFile) {
      if (!hasNonRoot) {
        violations.push({
          file,
          ruleId: "dockerfile-non-root-user",
          severity: "error",
          message: `${file} never drops to a non-root USER — add \`USER <non-root>\` after the install steps so the container does not run as root.`,
        });
      }
    }

    return violations;
  },
};
