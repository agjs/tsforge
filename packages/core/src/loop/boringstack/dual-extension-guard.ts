import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  composeGuards,
  type EditGuard,
  type IEditVeto,
} from "../tools/tool-context";
import { makeBoringstackEditGuard } from "./i18n-guard";

/**
 * BoringStack dual-extension guard: veto CREATING a `<base>.test.tsx` when a
 * `<base>.test.ts` sibling already exists (or vice versa).
 *
 * WHY: a same-basename `.ts` + `.tsx` pair in one directory makes TypeScript keep
 * the `.ts` and DROP the `.tsx` from its program (same-basename resolution), even
 * when the tsconfig `include` matches both. The type-aware ESLint program then
 * cannot place the orphaned `.tsx` and reports
 * `file was not found in any of the provided project(s)` on it, which fans out
 * across the WHOLE app. This WEDGED a live build for 190+ turns: the collapse token
 * mislabeled it a syntax break, the model hunted a non-existent `Parsing error`,
 * and `delete_file` is denied on the build path, so it could never clear the twin.
 *
 * PREVENTION over cleanup: an autofix that DELETES the orphan is unsafe — vitest
 * runs `*.test.tsx` by GLOB (not by TS-project membership), so the `.tsx` may hold
 * REAL executing tests; deleting it would silently drop coverage (a false green).
 * Blocking the duplicate at creation loses nothing: the model keeps its tests in the
 * one existing file. The create-guard reverts the just-written file on veto, so the
 * twin never lands.
 */

/** The would-be same-basename twin of a TEST file across the `.ts`/`.tsx` extension,
 *  or null when `file` is not a test file. `X.test.tsx` → `X.test.ts`, and vice
 *  versa. Pure — unit-testable. */
export function twinTestPath(file: string): string | null {
  if (file.endsWith(".test.tsx")) {
    return file.slice(0, -1); // ".test.tsx" → ".test.ts"
  }

  if (file.endsWith(".test.ts")) {
    return `${file}x`; // ".test.ts" → ".test.tsx"
  }

  return null;
}

/** Build the dual-extension edit guard for a build rooted at `cwd` (the clone dir).
 *  Only a fresh CREATE (empty `before`) of a test file whose extension-twin already
 *  exists on disk is vetoed — an edit to an existing file, or a lone test file, is
 *  never blocked. */
export function makeDualExtensionTestGuard(cwd: string): EditGuard {
  return (file, before): IEditVeto | null => {
    // Only a creation (empty before) can introduce the SECOND file of the pair; an
    // edit to an already-present file is left alone.
    if (before.trim() !== "") {
      return null;
    }

    const twin = twinTestPath(file);

    if (twin === null || !existsSync(join(cwd, twin))) {
      return null;
    }

    return {
      reason: "dual-extension-test",
      message:
        `create ${file} REJECTED: ${twin} already exists. A same-basename ` +
        `.test.ts + .test.tsx PAIR breaks the type-aware lint for the WHOLE app — ` +
        `TypeScript drops the .tsx from its program, and it cannot be auto-cleared ` +
        `(the build path can't delete files). Add these tests to the EXISTING ` +
        `${twin} (one test file per basename). If they need JSX, use a DIFFERENT ` +
        `basename for the render tests — e.g. a \`.render.test.tsx\` alongside ` +
        `${twin} — so the two files never share a basename. Do NOT recreate ${file}.`,
    };
  };
}

/** The composed edit guard for a boringstack build: BOTH the i18n-deletion guard
 *  (vetoes gutting a session-authored translation key / leaving invalid-JSON locale)
 *  AND the dual-extension guard (vetoes a same-basename `.test.ts`+`.test.tsx` twin).
 *  Extracted from `headless-build.ts` so the composition is behaviorally testable —
 *  a test asserts the returned guard vetoes an edit that EACH sub-guard catches, so
 *  dropping either from the composition fails the test. */
export function makeBoringstackBuildGuard(cwd: string): EditGuard {
  return composeGuards(
    makeBoringstackEditGuard(),
    makeDualExtensionTestGuard(cwd)
  );
}
