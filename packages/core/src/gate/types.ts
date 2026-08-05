/**
 * Build the gate that confirms "done" — and makes tsforge a TypeScript-SPECIALIZED
 * harness, not a generic file editor. It enforces strict TS on whatever the model
 * writes, in two layers, using tsforge's OWN bundled toolchain so it works on any
 * target regardless of that project's setup:
 *   1. `tsc --strict --noUncheckedIndexedAccess` — the TYPE-aware floor (unguarded
 *      `arr[i]`, null-safety, real type errors). Greenfield gets a strict tsconfig
 *      brought in; an existing project's own tsconfig is respected.
 *   2. the bundled eslint strict config — the SYNTACTIC idioms (no `as`/`any`/`!`,
 *      no over-annotation), which need no type info or deps.
 * The deterministic gate loop + rule-docs cards + ast-grep polish then drive the
 * local model's output up to that bar — that's the uplift.
 */
export interface IGateSpec {
  /** The shell command run to verify (must exit 0). */
  command: string;
  /** The individual stages `command` joins with `&&`, in order. That join is
   *  fail-fast by design — the cheap static floor rejects before anything pays
   *  for a test run — so a failing gate's error count is whichever stage died
   *  first, not total residual. A caller that MEASURES residual errors rather
   *  than gating on them needs the stages to run them all; it cannot recover
   *  them from the joined string. Optional: hand-built specs need not supply it. */
  parts?: readonly string[];
  /** A short human label for the banner. */
  label: string;
}

/** One lint violation on a single file (errors only), for write-time feedback. */
export interface IFileLintProblem {
  line: number;
  message: string;
  ruleId: string;
}

/** Lint ONE just-written file, returning its errors. Reused per write. */
export type FileLinter = (absPath: string) => Promise<IFileLintProblem[]>;
