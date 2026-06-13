import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const OVERRIDE_KEY_PATTERN = /^(\s*)"(?:overrides|resolutions)"\s*:/u;
const LINE_COMMENT_PATTERN = /^\s*\/\/.*$/u;

function hasAdjacentComment(lines: readonly string[], index: number): boolean {
  const line = lines[index];

  if (line === undefined) {
    return false;
  }

  if (/\/\/.*$/u.test(line)) {
    return true;
  }

  const previous = lines[index - 1];

  return previous !== undefined && LINE_COMMENT_PATTERN.test(previous);
}

export const dependencyOverridesRequireCommentRule: IMetaRule = {
  id: "dependency-overrides-require-comment",
  category: "supply-chain",
  description:
    "overrides/resolutions in package.json must include an adjacent comment explaining why.",
  severity: "warn",
  run({ readFile }) {
    const violations: IMetaRuleViolation[] = [];
    const text = readFile("package.json");

    if (text === null) {
      return violations;
    }

    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (line === undefined || !OVERRIDE_KEY_PATTERN.test(line)) {
        continue;
      }

      if (hasAdjacentComment(lines, index)) {
        continue;
      }

      const keyName = line.includes("overrides") ? "overrides" : "resolutions";

      violations.push({
        file: "package.json",
        ruleId: "dependency-overrides-require-comment",
        severity: "warn",
        message: `"${keyName}" is declared without an adjacent comment — document why the override is required (security patch, upstream bug, etc.).`,
      });
    }

    return violations;
  },
};
