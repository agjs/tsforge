import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { dockerInstructionLines } from "./utils";

/**
 * Secrets must not be baked into the image via `ENV`/`ARG` literals — they
 * persist in every image layer and `docker history`, readable by anyone who
 * pulls the image. Inject them at runtime (`--env-file`, a secret manager, or
 * BuildKit `--secret`) instead.
 */
const SECRET_NAME =
  /(^|_)(KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)(_|$)/u;

/** The `NAME=value` (or `NAME value`) pairs declared on one ENV/ARG line. */
function declaredName(args: string): string | null {
  const eq = args.indexOf("=");
  const name = eq === -1 ? args.split(/\s+/u)[0] : args.slice(0, eq);

  return name === undefined || name.length === 0 ? null : name.trim();
}

/** True when the line actually assigns a value (vs. a bare build-time `ARG`). */
function hasAssignedValue(instruction: string, args: string): boolean {
  if (args.includes("=")) {
    const value = args.slice(args.indexOf("=") + 1).trim();

    return value.length > 0;
  }

  // `ENV NAME value` form assigns; bare `ARG NAME` does not.
  return instruction === "ENV" && /\S+\s+\S/u.test(args);
}

export const dockerfileNoSecretsInEnvArgRule: IMetaRule = {
  id: "dockerfile-no-secrets-in-env-arg",
  category: "container",
  description:
    "Dockerfiles must not assign secret-looking ENV/ARG values (KEY/TOKEN/SECRET/PASSWORD) — they bake into image layers. Inject secrets at runtime.",
  severity: "error",
  run(ctx) {
    const violations: IMetaRuleViolation[] = [];

    for (const line of dockerInstructionLines(ctx)) {
      if (line.instruction !== "ENV" && line.instruction !== "ARG") {
        continue;
      }

      const name = declaredName(line.args);

      if (
        name === null ||
        !SECRET_NAME.test(name.toUpperCase()) ||
        !hasAssignedValue(line.instruction, line.args)
      ) {
        continue;
      }

      violations.push({
        file: line.file,
        ruleId: "dockerfile-no-secrets-in-env-arg",
        severity: "error",
        message: `Line ${line.lineNo}: \`${line.instruction} ${name}=…\` bakes a secret into the image layers (visible in \`docker history\`). Inject it at runtime via \`--env-file\`/secret manager or a BuildKit \`--secret\` mount.`,
      });
    }

    return violations;
  },
};
