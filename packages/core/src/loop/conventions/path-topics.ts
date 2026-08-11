import { basename } from "node:path";

/**
 * Paths that may be written without a prior `pull_conventions` — bootstrap /
 * config / assets, not feature source the guides teach.
 */
export function isConventionExemptPath(file: string): boolean {
  const norm = file.replaceAll("\\", "/");
  const base = basename(norm);

  if (base === "package.json" || base === "index.html") {
    return true;
  }

  if (
    base === "package-lock.json" ||
    base === "bun.lock" ||
    base === "bun.lockb" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock"
  ) {
    return true;
  }

  if (base.startsWith(".env")) {
    return true;
  }

  if (base.endsWith(".css")) {
    return true;
  }

  if (base.startsWith("vite.config.") || base.startsWith("tsconfig")) {
    return true;
  }

  if (norm === "public" || norm.startsWith("public/")) {
    return true;
  }

  return false;
}

/** Paths that look like form UI / form hooks — require the forms guide. */
function looksFormish(file: string): boolean {
  const base = basename(file.replaceAll("\\", "/")).toLowerCase();

  return (
    base.includes("form") || base.includes("schema") || /use-?form/u.test(base)
  );
}

/**
 * Map a write path to convention topic ids the agent must have pulled before
 * first write. Only topics present in `available` are returned (house-only
 * sessions omit BoringStack-only topics).
 */
export function pathToConventionTopics(
  file: string,
  available: ReadonlySet<string> | readonly string[]
): string[] {
  const avail =
    available instanceof Set ? available : new Set<string>(available);
  const norm = file.replaceAll("\\", "/");
  const base = basename(norm);
  const needed: string[] = [];

  const add = (topic: string): void => {
    if (avail.has(topic) && !needed.includes(topic)) {
      needed.push(topic);
    }
  };

  if (base.includes(".test.") || base.includes(".spec.")) {
    add("testing");
  }

  if (base.endsWith(".hooks.ts")) {
    add("state");

    if (looksFormish(norm)) {
      add("forms");
    }

    return needed;
  }

  if (base.endsWith(".tsx")) {
    add("component-anatomy");
    add("file-layout");
    add("state");
    add("jsx");

    if (looksFormish(norm)) {
      add("forms");
    }
  } else if (base.endsWith(".ts")) {
    add("no-casts");
    add("lint-gotchas");
  }

  return needed;
}

/**
 * If this is a first write to `file` under an active convention library, return
 * a rejection message naming missing topic ids; otherwise null (allow write).
 */
export function missingConventionPullReject(
  file: string,
  opts: {
    readonly conventionsActive: boolean;
    readonly touched: ReadonlySet<string> | undefined;
    readonly pulledTopics: ReadonlySet<string> | undefined;
    readonly availableTopics: readonly string[];
  }
): string | null {
  if (!opts.conventionsActive) {
    return null;
  }

  const norm = file.replaceAll("\\", "/");

  if (isConventionExemptPath(norm)) {
    return null;
  }

  if (opts.touched?.has(norm) === true) {
    return null;
  }

  const needed = pathToConventionTopics(norm, opts.availableTopics);

  if (needed.length === 0) {
    return null;
  }

  const pulled = opts.pulledTopics ?? new Set<string>();
  const missing = needed.filter((t) => !pulled.has(t));

  if (missing.length === 0) {
    return null;
  }

  return (
    `REJECTED: pull_conventions before first write to ${norm}. ` +
    `Missing topics: ${missing.join(", ")}. ` +
    `Call pull_conventions for each, then retry.`
  );
}
