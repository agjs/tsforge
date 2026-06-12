export interface IPackageJsonDeps {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract string-valued dependency map from a package.json object. */
function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }

  return out;
}

/** Parse package.json JSON object, returning null on error. */
export function parsePackageJsonObject(
  parsed: unknown
): IPackageJsonDeps | null {
  if (!isRecord(parsed)) {
    return null;
  }

  let dependencies: Record<string, string> | undefined;
  let devDependencies: Record<string, string> | undefined;

  const depsValue = parsed.dependencies;
  const devDepsValue = parsed.devDependencies;

  if (depsValue !== undefined) {
    dependencies = toStringRecord(depsValue);
  }

  if (devDepsValue !== undefined) {
    devDependencies = toStringRecord(devDepsValue);
  }

  return { dependencies, devDependencies };
}
