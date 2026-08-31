// Throwaway file for a live smoke test of tsforge-github-review (the GitHub
// Action that posts tsforge review findings as inline PR comments). Not part
// of the real codebase — this PR is closed and the branch deleted right
// after the test confirms an inline comment lands correctly.

export function sumInclusive(values: number[], upToIndex: number): number {
  let total = 0;

  // Bug: should be `i <= upToIndex`, this skips the last element the name
  // promises to include, and also throws on an empty array via values[0].
  for (let i = 0; i < upToIndex; i++) {
    total += values[i];
  }

  return total;
}
