import { basename } from "node:path";
import type { IConventionProvider } from "../conventions-provider";

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
    // Hooks files are exactly where casts, floating promises and logging land;
    // the early return used to starve them of both topics (self-eval seed-3).
    add("no-casts");
    add("lint-gotchas");

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
    // Components cast too — without this the type-guard pattern only arrived
    // via reactive PUSH, after the bad `as` was already written (seed-3).
    // lint-gotchas stays off .tsx to bound the up-front token cost.
    add("no-casts");

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
 * Human-readable path→topics table for the pull contract, derived by PROBING
 * `pathToConventionTopics` with canonical sample paths so it can never drift
 * from the enforcement logic. Rows whose sample maps to nothing are omitted
 * (topic not in `available`).
 */
export function renderPathTopicMap(available: readonly string[]): string {
  const probe = (sample: string): string =>
    pathToConventionTopics(sample, available).join(", ");
  const rows: [label: string, topics: string][] = [
    ["*.test.*", probe("x.test.ts")],
    ["*.hooks.ts", probe("X.hooks.ts")],
    ["*.tsx", probe("X.tsx")],
    ["formish *.tsx (name has form/schema)", probe("XForm.tsx")],
    ["other *.ts", probe("x.ts")],
  ];
  const rendered = rows
    .filter(([, topics]) => topics.length > 0)
    .map(([label, topics]) => `${label} → ${topics}`)
    .join("; ");

  return rendered.length > 0 ? `Path→topics: ${rendered}.` : "";
}

/**
 * Path→topic table from a provider's own `topicsForPath` + probe samples, so a
 * stack map cannot drift from the function the pull gate actually calls.
 */
export function renderProbedPathTopicMap(
  available: readonly string[],
  topicsForPath: (file: string) => readonly string[],
  probes: readonly { readonly label: string; readonly sample: string }[]
): string {
  const avail = new Set<string>(available);
  const rows: [label: string, topics: string][] = [];

  for (const probe of probes) {
    const topics: string[] = [];

    for (const topic of topicsForPath(probe.sample)) {
      if (avail.has(topic) && !topics.includes(topic)) {
        topics.push(topic);
      }
    }

    rows.push([probe.label, topics.join(", ")]);
  }

  const rendered = rows
    .filter(([, topics]) => topics.length > 0)
    .map(([label, topics]) => `${label} → ${topics}`)
    .join("; ");

  return rendered.length > 0 ? `Path→topics: ${rendered}.` : "";
}

/**
 * Topic ids a first write to `file` requires but the session has not pulled;
 * empty means the write may proceed. Pure — the shared decision both write
 * tools gate on.
 */
export function missingConventionTopics(
  file: string,
  opts: {
    readonly conventionsActive: boolean;
    readonly touched: ReadonlySet<string> | undefined;
    readonly pulledTopics: ReadonlySet<string> | undefined;
    readonly availableTopics: readonly string[];
    /** Stack mapper; when set, replaces core `pathToConventionTopics`. */
    readonly topicsForPath?: (file: string) => readonly string[];
  }
): string[] {
  if (!opts.conventionsActive) {
    return [];
  }

  const norm = file.replaceAll("\\", "/");

  if (isConventionExemptPath(norm)) {
    return [];
  }

  if (opts.touched?.has(norm) === true) {
    return [];
  }

  const avail = new Set<string>(opts.availableTopics);
  const needed: string[] = [];

  if (opts.topicsForPath === undefined) {
    for (const topic of pathToConventionTopics(norm, opts.availableTopics)) {
      needed.push(topic);
    }
  } else {
    for (const topic of opts.topicsForPath(norm)) {
      if (avail.has(topic) && !needed.includes(topic)) {
        needed.push(topic);
      }
    }
  }

  const pulled = opts.pulledTopics ?? new Set<string>();

  return needed.filter((t) => !pulled.has(t));
}

/**
 * The write-tool convention gate. First write to a path with unpulled topics is
 * still REJECTED (pull-before-write stands: the attempt was authored without
 * having read the pattern), but the reject EMBEDS the missing guides and marks
 * them pulled — one reject + retry, instead of the old reject → one
 * `pull_conventions` call per topic → retry loop (2N+1 turns; self-eval seed-4).
 * Returns the reject message, or null to allow the write.
 */
export function conventionPullGate(
  file: string,
  ctx: {
    readonly conventions?: IConventionProvider | undefined;
    readonly touched?: ReadonlySet<string> | undefined;
    pulledTopics?: Set<string> | undefined;
  }
): string | null {
  const provider = ctx.conventions;

  if (provider === undefined) {
    return null;
  }

  const missing = missingConventionTopics(file, {
    conventionsActive: true,
    touched: ctx.touched,
    pulledTopics: ctx.pulledTopics,
    availableTopics: provider.topics(),
    ...(provider.topicsForPath === undefined
      ? {}
      : {
          topicsForPath: (path: string) => provider.topicsForPath?.(path) ?? [],
        }),
  });

  if (missing.length === 0) {
    return null;
  }

  const pulled = (ctx.pulledTopics ??= new Set<string>());
  const guides: string[] = [];

  for (const topic of missing) {
    const guide = provider.guide(topic);

    // Marked pulled even when a guide body is missing (defensive): the retry
    // must not re-reject on a topic the provider can't teach.
    pulled.add(topic);

    if (guide !== null) {
      guides.push(`=== CONVENTION: ${topic} ===\n${guide}`);
    }
  }

  const norm = file.replaceAll("\\", "/");

  return (
    `REJECTED: first write to ${norm} requires conventions you have not read: ` +
    `${missing.join(", ")}.\n` +
    "The guides are included below and now count as PULLED — read them, then " +
    "RETRY this write corrected to match. Do NOT call pull_conventions for " +
    "these topics.\n\n" +
    guides.join("\n\n")
  );
}
