/** True for relative import specifiers (`./x`, `../x`) — i.e. paths inside the
 *  project, as opposed to bare package specifiers (`react`, `@scope/pkg`). */
export function isRelativeImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

/** Path segments of a "/"-separated specifier, dropping "", ".", "..". */
export function pathSegments(specifier: string): string[] {
  return specifier
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** True if any directory segment of the specifier is in `dirs`. */
export function hasDirSegment(
  specifier: string,
  dirs: ReadonlySet<string>
): boolean {
  return pathSegments(specifier).some((seg) => dirs.has(seg));
}

/** True if the specifier's final segment names a test/spec module
 *  (`foo.test`, `foo.test.ts`, `foo.spec.tsx`, …). */
export function isTestFileName(specifier: string): boolean {
  const segments = specifier.split("/");
  const base = segments[segments.length - 1] ?? "";

  return /\.(?:test|spec)(?:\.[^.]+)?$/.test(base);
}
