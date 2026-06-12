/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string */

import { join } from "node:path";
import { resolveScopeFiles } from "../lib/fs";
import type { IStackProfile } from "./stack-detection.types";
import {
  PACK_REGISTRY,
  ALWAYS_ON_PACKS,
  type IPackRegistry,
  type IPackId,
} from "./packs";

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
  if (typeof obj !== "object" || obj === null) {
    return new Set();
  }

  const depsObj: unknown = (obj as Record<string, unknown>)[field];

  if (typeof depsObj !== "object" || depsObj === null) {
    return new Set();
  }

  return new Set(Object.keys(depsObj as Record<string, unknown>));
}

/** Check which packs have file-based matches, returning both match set and whether any were found. */
async function checkFileMatches(
  cwd: string,
  registry: IPackRegistry
): Promise<{ matches: Set<string>; anyFound: boolean }> {
  const matches = new Set<string>();

  for (const packId in registry) {
    const descriptor = registry[packId as IPackId];
    // files may not exist on all variants of appliesWhen, so use optional chaining
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
        matches.add(packId);
      }
    } catch {
      // If file resolution fails, skip this pack's file checks
    }
  }

  return { matches, anyFound: matches.size > 0 };
}

/** Evaluate a single pack descriptor against available deps and file matches. */
function evaluatePack(
  packId: IPackId,
  descriptor: IPackRegistry[IPackId],
  allDeps: Set<string>,
  fileMatches: Set<string>
): { enabled: boolean; signal?: string } {
  // Always-on packs are handled separately
  if ("always" in descriptor.appliesWhen && descriptor.appliesWhen.always) {
    return { enabled: false };
  }

  if ("anyDeps" in descriptor.appliesWhen) {
    const anyDepsOption = descriptor.appliesWhen.anyDeps;
    if (anyDepsOption) {
      const anyDepsList = Array.from(anyDepsOption);

      if (anyDepsList.length > 0) {
        const matched = anyDepsList.find((dep) => allDeps.has(dep));

        if (matched !== undefined) {
          return {
            enabled: true,
            signal: `${descriptor.label} (${matched})`,
          };
        }
      }
    }
  }

  if ("allDeps" in descriptor.appliesWhen) {
    const allDepsRequiredOption = descriptor.appliesWhen.allDeps;
    if (allDepsRequiredOption) {
      const allDepsList = Array.from(allDepsRequiredOption);

      if (allDepsList.length > 0) {
        const hasAll = allDepsList.every((dep) => allDeps.has(dep));

        if (hasAll) {
          return { enabled: true, signal: descriptor.label };
        }
      }
    }
  }

  // Check files only if not already enabled by deps
  if ("files" in descriptor.appliesWhen) {
    const filesOption = descriptor.appliesWhen.files;
    if (filesOption) {
      const filesList = Array.from(filesOption);

      if (filesList.length > 0 && fileMatches.has(packId)) {
        return { enabled: true, signal: `${descriptor.label} (file detected)` };
      }
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

  // No package.json or invalid JSON — return minimal profile
  if (!valid) {
    const reason = exists ? "invalid package.json" : "no package.json found";

    return {
      name: "generic",
      packs: ["generic-ts"],
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

  for (const packId in PACK_REGISTRY) {
    const packIdTyped = packId as IPackId;

    if (alwaysOnSet.has(packId)) {
      continue;
    }

    const descriptor = PACK_REGISTRY[packIdTyped];
    const { enabled, signal } = evaluatePack(
      packIdTyped,
      descriptor,
      allDeps,
      fileMatches
    );

    if (enabled) {
      enabledPacks.push(packId);

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
