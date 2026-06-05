/** One failure from the gate, with a stable key so we can diff across cycles. */
export interface IErrorItem {
  key: string;
  file?: string;
  line?: number;
  rule?: string;
  message: string;
}

export type ErrorSet = IErrorItem[];

export interface IErrorDiff {
  fixed: ErrorSet;
  introduced: ErrorSet;
  remaining: ErrorSet;
}

/** What changed between two cycles — the gradient the model descends. */
export function diffErrorSets(prev: ErrorSet, next: ErrorSet): IErrorDiff {
  const prevKeys = new Set(prev.map((e) => e.key));
  const nextKeys = new Set(next.map((e) => e.key));

  return {
    fixed: prev.filter((e) => !nextKeys.has(e.key)),
    introduced: next.filter((e) => !prevKeys.has(e.key)),
    remaining: next.filter((e) => prevKeys.has(e.key)),
  };
}

/** Progress = fewer errors than last cycle. */
export function shrank(prev: ErrorSet, next: ErrorSet): boolean {
  return next.length < prev.length;
}

/**
 * True when two cycles produced the EXACT same error set (same keys). This —
 * not "didn't shrink" — is the honest signal of a stuck model: it's spinning
 * without changing the gate outcome at all. Any difference (fewer, more, or a
 * different mix) means the model is still moving the problem and we keep going.
 */
export function sameErrorSet(prev: ErrorSet, next: ErrorSet): boolean {
  if (prev.length !== next.length) {
    return false;
  }

  const a = prev.map((e) => e.key).sort();
  const b = next.map((e) => e.key).sort();

  return a.every((key, i) => key === b[i]);
}
