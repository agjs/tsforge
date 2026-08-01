/** Platform predicates. Centralized so platform-specific branches read by intent and
 *  stay consistent, instead of scattering raw `process.platform` string comparisons. */

/** True on Windows (`process.platform === "win32"`). */
export function isWin32(): boolean {
  return process.platform === "win32";
}
