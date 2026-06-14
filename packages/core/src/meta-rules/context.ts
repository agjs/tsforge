import { join, extname } from "node:path";
import { readdirSync, statSync, readFileSync } from "node:fs";
import type { IMetaRuleContext } from "./meta-rules.types";

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Directories to skip during recursive file walks. */
const IGNORE_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
  "coverage",
]);

/** Source files: .ts and .tsx under src/, tests/, scripts/. */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];

  const scanDir = (dir: string, relBase: string): void => {
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = join(relBase, entry);

      // Skip ignored directories
      if (IGNORE_SEGMENTS.has(entry)) {
        continue;
      }

      try {
        const stat = statSync(full);

        if (stat.isDirectory()) {
          scanDir(full, rel);
        } else if (stat.isFile()) {
          const ext = extname(entry);

          // Skip generated output (*.gen.ts — e.g. TanStack's route tree). It
          // ships with `/* eslint-disable */` + `@ts-nocheck`, which the
          // source-text meta-rules (no-eslint-disable-comments,
          // no-ts-suppressions) would otherwise flag. The model cannot write
          // *.gen.ts (vendored scope), so the only such file is harness/codegen
          // output — hand-written files stay fully covered, keeping the bypass
          // ban airtight where it matters.
          if ((ext === ".ts" || ext === ".tsx") && !entry.endsWith(".gen.ts")) {
            out.push(rel);
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  };

  for (const baseDir of ["src", "tests", "scripts"]) {
    scanDir(join(root, baseDir), baseDir);
  }

  return out.sort();
}

/** Config files: tsconfig*, eslint*, package.json, *.config.* at root. */
function collectConfigFiles(root: string): string[] {
  const out: string[] = [];

  try {
    const entries = readdirSync(root);

    for (const entry of entries) {
      const full = join(root, entry);

      try {
        const stat = statSync(full);

        if (!stat.isFile()) {
          continue;
        }

        // Match tsconfig.*, eslint.*, package.json, *.config.*
        if (
          entry.startsWith("tsconfig") ||
          entry.startsWith("eslint") ||
          entry === "package.json" ||
          entry.includes(".config.")
        ) {
          out.push(entry);
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Root doesn't exist or is unreadable
  }

  return out.sort();
}

/** GitHub workflow files: .github/workflows/*.yml|yaml. */
function collectWorkflowFiles(root: string): string[] {
  const out: string[] = [];
  const workflowDir = join(root, ".github", "workflows");

  try {
    const entries = readdirSync(workflowDir);

    for (const entry of entries) {
      const ext = extname(entry);

      if (ext === ".yml" || ext === ".yaml") {
        out.push(join(".github", "workflows", entry));
      }
    }
  } catch {
    // Workflows dir doesn't exist
  }

  return out.sort();
}

/** True for a Dockerfile-shaped name: `Dockerfile`, `Dockerfile.<x>`, `<x>.Dockerfile`. */
function isDockerfileName(entry: string): boolean {
  return (
    entry === "Dockerfile" ||
    entry.startsWith("Dockerfile.") ||
    entry.endsWith(".Dockerfile")
  );
}

/** Dockerfiles at the root and one directory level down (e.g. docker/, apps/*). */
function collectDockerfiles(root: string): string[] {
  const out: string[] = [];

  const scanDir = (dir: string, relBase: string): void => {
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_SEGMENTS.has(entry)) {
        continue;
      }

      const full = join(dir, entry);
      const rel = relBase === "" ? entry : join(relBase, entry);

      try {
        const stat = statSync(full);

        if (stat.isFile() && isDockerfileName(entry)) {
          out.push(rel);
        } else if (stat.isDirectory() && relBase === "") {
          scanDir(full, entry); // one level only
        }
      } catch {
        // Skip unreadable entries
      }
    }
  };

  scanDir(root, "");

  return out.sort();
}

/** Parse package.json, returning null on error. */
function parsePackageJson(root: string): Record<string, unknown> | null {
  const pkgPath = join(root, "package.json");

  try {
    const stat = statSync(pkgPath);

    if (!stat.isFile()) {
      return null;
    }

    const text = readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(text);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build the rule context: list source/config/workflow files, parse package.json,
 * set up a cached file reader.
 */
export function buildMetaRuleContext(
  root: string,
  activePacks: readonly string[]
): IMetaRuleContext {
  const fileCache = new Map<string, string | null>();

  const readFile = (relPath: string): string | null => {
    if (fileCache.has(relPath)) {
      return fileCache.get(relPath) ?? null;
    }

    try {
      const full = join(root, relPath);
      const stat = statSync(full);

      if (!stat.isFile()) {
        fileCache.set(relPath, null);

        return null;
      }

      const text = readFileSync(full, "utf8");

      fileCache.set(relPath, text);

      return text;
    } catch {
      fileCache.set(relPath, null);

      return null;
    }
  };

  return {
    root,
    packageJson: parsePackageJson(root),
    sourceFiles: collectSourceFiles(root),
    configFiles: collectConfigFiles(root),
    workflowFiles: collectWorkflowFiles(root),
    dockerfiles: collectDockerfiles(root),
    activePacks,
    readFile,
  };
}
