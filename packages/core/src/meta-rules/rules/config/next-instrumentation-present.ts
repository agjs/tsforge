import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

function hasNextDependency(
  packageJson: Record<string, unknown> | null
): boolean {
  if (packageJson === null) {
    return false;
  }

  const parsed = parsePackageJsonObject(packageJson);

  if (parsed === null) {
    return false;
  }

  const merged: Record<string, string> = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {}),
  };

  return merged.next !== undefined;
}

function hasAppRouter(sourceFiles: readonly string[]): boolean {
  return sourceFiles.some(
    (file) => file.startsWith("app/") || file.startsWith("src/app/")
  );
}

export const nextInstrumentationPresentRule: IMetaRule = {
  id: "next-instrumentation-present",
  category: "config",
  description:
    "Recommend instrumentation.ts for OpenTelemetry when using the Next.js app router.",
  severity: "warn",
  appliesTo: ["nextjs"],
  run({ packageJson, sourceFiles, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    if (!hasNextDependency(packageJson) || !hasAppRouter(sourceFiles)) {
      return violations;
    }

    const instrumentationPaths = [
      "instrumentation.ts",
      "src/instrumentation.ts",
    ] as const;

    const hasInstrumentation = instrumentationPaths.some(
      (path) => readFile(path) !== null
    );

    if (!hasInstrumentation) {
      violations.push({
        file: "instrumentation.ts",
        ruleId: "next-instrumentation-present",
        severity: "warn",
        message:
          "Add instrumentation.ts at the project root (or src/) with registerOTel for OpenTelemetry tracing of Server Components and route handlers.",
      });
    }

    return violations;
  },
};
