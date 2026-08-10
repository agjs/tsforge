import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { resolveScopeFiles } from "../lib/fs";
import type { IStackProfile } from "./stack-detection.types";
import {
  PACK_REGISTRY,
  ALWAYS_ON_PACKS,
  type IPackRegistry,
  type IPackId,
} from "./packs";

/** The pack ids that identify a WEB (browser UI) build. Used to scope behaviours
 *  that must NOT apply to web apps (e.g. the scratch-simplicity prompt, whose
 *  "shortest solution / no extra files" advice fights the views/components
 *  architecture the web scaffold requires). */
const WEB_PACK_IDS: readonly string[] = [
  "react",
  "react-component-architecture",
  "tanstack-query",
];

/** True when the detected stack is a web/browser UI build. */
export function isWebStack(profile: IStackProfile): boolean {
  return profile.packs.some((p) => WEB_PACK_IDS.includes(p));
}

/** Parse package.json and extract deps/devDeps, tolerating missing/invalid JSON. */
async function loadPackageDeps(cwd: string): Promise<{
  deps: Set<string>;
  devDeps: Set<string>;
  exists: boolean;
  valid: boolean;
}> {
  const pkgPath = join(cwd, "package.json");
  const file = Bun.file(pkgPath);

  const exists = await file.exists();

  if (!exists) {
    return { deps: new Set(), devDeps: new Set(), exists: false, valid: false };
  }

  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);

    const deps = extractDeps(parsed, "dependencies");
    const devDeps = extractDeps(parsed, "devDependencies");

    return { deps, devDeps, exists: true, valid: true };
  } catch {
    return { deps: new Set(), devDeps: new Set(), exists: true, valid: false };
  }
}

/** Extract dependency keys from a parsed package.json object. */
function extractDeps(obj: unknown, field: string): Set<string> {
  if (!isRecord(obj)) {
    return new Set();
  }

  const depsObj = obj[field];

  if (!isRecord(depsObj)) {
    return new Set();
  }

  return new Set(Object.keys(depsObj));
}

/** Check which packs have file-based matches, returning both match set and whether any were found. */
async function checkFileMatches(
  cwd: string,
  registry: IPackRegistry
): Promise<{ matches: Set<string>; anyFound: boolean }> {
  const matches = new Set<string>();

  for (const descriptor of Object.values(registry)) {
    const filesOption =
      "files" in descriptor.appliesWhen
        ? descriptor.appliesWhen.files
        : undefined;

    if (!filesOption) {
      continue;
    }

    const filesList = Array.from(filesOption);

    if (filesList.length === 0) {
      continue;
    }

    try {
      const resolved = await resolveScopeFiles(cwd, filesList);

      if (resolved.length > 0) {
        matches.add(descriptor.id);
      }
    } catch {
      // If file resolution fails, skip this pack's file checks
    }
  }

  return { matches, anyFound: matches.size > 0 };
}

/** Check if any required dependencies are present. */
function matchAnyDeps(
  required: readonly string[] | undefined,
  allDeps: Set<string>
): string | undefined {
  if (!required || required.length === 0) {
    return undefined;
  }

  return Array.from(required).find((dep) => allDeps.has(dep));
}

/** Check if all required dependencies are present. */
function matchAllDeps(
  required: readonly string[] | undefined,
  allDeps: Set<string>
): boolean {
  if (!required || required.length === 0) {
    return false;
  }

  return Array.from(required).every((dep) => allDeps.has(dep));
}

/** Evaluate a single pack descriptor against available deps and file matches. */
function evaluatePack(
  packId: IPackId,
  descriptor: IPackRegistry[IPackId],
  allDeps: Set<string>,
  fileMatches: Set<string>
): { enabled: boolean; signal?: string } {
  // Always-on packs are handled separately
  if ("always" in descriptor.appliesWhen) {
    return { enabled: false };
  }

  if ("anyDeps" in descriptor.appliesWhen) {
    const matched = matchAnyDeps(descriptor.appliesWhen.anyDeps, allDeps);

    if (matched !== undefined) {
      return { enabled: true, signal: `${descriptor.label} (${matched})` };
    }
  }

  if ("allDeps" in descriptor.appliesWhen) {
    const hasAll = matchAllDeps(descriptor.appliesWhen.allDeps, allDeps);

    if (hasAll) {
      return { enabled: true, signal: descriptor.label };
    }
  }

  if ("files" in descriptor.appliesWhen) {
    const filesList = Array.from(descriptor.appliesWhen.files);

    if (filesList.length > 0 && fileMatches.has(packId)) {
      return { enabled: true, signal: `${descriptor.label} (file detected)` };
    }
  }

  return { enabled: false };
}

/**
 * Detect the target project's technology stack and return an IStackProfile
 * that determines which rule packs should be enabled.
 *
 * Detection layers:
 *  1. Parse package.json to extract dependencies and devDependencies
 *  2. Check file existence for packs with file-based triggers
 *  3. Evaluate every pack descriptor and collect enabled pack IDs
 *
 * Always-on packs are emitted first (deterministic), then framework/library packs.
 */
export async function detectStack(cwd: string): Promise<IStackProfile> {
  const { deps, devDeps, exists, valid } = await loadPackageDeps(cwd);

  // No package.json or invalid JSON — still load always-on packs (env-access,
  // code-flow, …). Framework packs stay dep-gated and need a valid package.json.
  if (!valid) {
    const reason = exists ? "invalid package.json" : "no package.json found";

    return {
      name: "generic",
      packs: [...ALWAYS_ON_PACKS],
      confidence: "guess",
      reason,
    };
  }

  const allDeps = new Set([...deps, ...devDeps]);
  const { matches: fileMatches, anyFound: filesFound } = await checkFileMatches(
    cwd,
    PACK_REGISTRY
  );

  const enabledPacks: string[] = [];
  const matchedSignals: string[] = [];

  // Add always-on packs first (deterministic order)
  for (const packId of Array.from(ALWAYS_ON_PACKS)) {
    enabledPacks.push(packId);
  }

  // Evaluate and add framework/library packs
  const alwaysOnSet = new Set<string>(Array.from(ALWAYS_ON_PACKS));

  for (const descriptor of Object.values(PACK_REGISTRY)) {
    if (alwaysOnSet.has(descriptor.id)) {
      continue;
    }

    const { enabled, signal } = evaluatePack(
      descriptor.id,
      descriptor,
      allDeps,
      fileMatches
    );

    if (enabled) {
      enabledPacks.push(descriptor.id);

      if (signal !== undefined) {
        matchedSignals.push(signal);
      }
    }
  }

  // Determine confidence level
  const hasDepMatches = matchedSignals.some(
    (s) => !s.includes("(file detected)")
  );
  const confidence: "certain" | "likely" | "guess" = hasDepMatches
    ? "certain"
    : filesFound
      ? "likely"
      : "guess";

  // Determine stack name (framework/library packs only, excluding always-on)
  const frameworkPacks = enabledPacks.filter((p) => !alwaysOnSet.has(p));
  const stackName =
    frameworkPacks.length > 0 ? frameworkPacks.join("+") : "generic";

  const reason =
    matchedSignals.length > 0
      ? `Detected: ${matchedSignals.join(", ")}`
      : "Generic TypeScript project (no framework/library detected)";

  return {
    name: stackName,
    packs: enabledPacks,
    confidence,
    reason,
  };
}
