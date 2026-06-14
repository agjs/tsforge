import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";
import { dockerInstructionLines } from "./utils";

/**
 * Every `FROM` must pin its base image to an explicit, non-floating tag (or a
 * digest). `latest` (or no tag) changes underneath you between builds with no
 * diff — non-reproducible images and silent base-image drift.
 */
const FROM_PATTERN = /^(?<ref>\S+)(?:\s+[Aa][Ss]\s+(?<stage>\S+))?/u;

/** The tag of an image ref, or null when untagged. Splits on the LAST `/` so a
 *  registry host:port (which also contains `:`) is not mistaken for a tag. */
function imageTag(ref: string): string | null {
  const lastSlash = ref.lastIndexOf("/");
  const finalSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const colon = finalSegment.indexOf(":");

  return colon === -1 ? null : finalSegment.slice(colon + 1);
}

export const dockerfileBaseImagePinnedRule: IMetaRule = {
  id: "dockerfile-base-image-pinned",
  category: "container",
  description:
    "Dockerfile FROM instructions must pin an explicit non-latest tag (or a digest) so image builds are reproducible.",
  severity: "error",
  run(ctx) {
    const violations: IMetaRuleViolation[] = [];
    const stages = new Set<string>();

    for (const line of dockerInstructionLines(ctx)) {
      if (line.instruction !== "FROM") {
        continue;
      }

      const match = FROM_PATTERN.exec(line.args);
      const ref = match?.groups?.ref;
      const stage = match?.groups?.stage;

      if (stage !== undefined) {
        stages.add(stage.toLowerCase());
      }

      if (ref === undefined) {
        continue;
      }

      // Skip references to an earlier build stage and the empty `scratch` base.
      if (stages.has(ref.toLowerCase()) || ref.toLowerCase() === "scratch") {
        continue;
      }

      const pinnedByDigest = ref.includes("@sha256:");
      const tag = imageTag(ref);

      if (pinnedByDigest || (tag !== null && tag !== "latest")) {
        continue;
      }

      const reason =
        tag === "latest" ? "uses the floating `latest` tag" : "has no tag";

      violations.push({
        file: line.file,
        ruleId: "dockerfile-base-image-pinned",
        severity: "error",
        message: `Line ${line.lineNo}: \`FROM ${ref}\` ${reason} — pin an explicit version (e.g. \`node:24.3.0-bookworm\`) or a \`@sha256:\` digest for reproducible builds.`,
      });
    }

    return violations;
  },
};
