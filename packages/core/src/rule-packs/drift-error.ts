/**
 * Raised when an external plugin's on-disk content no longer matches the
 * fingerprint captured at load (audit F19).
 *
 * A distinct type, in a dependency-free module, so the BEST-EFFORT catches on the
 * write path (the write-time linter, `runWriteGuard`) can rethrow it. Those
 * catches exist to keep a broken linter from breaking a build; absorbing a drift
 * into "no findings" instead reports a file clean under rules that are no longer
 * the ones that were loaded.
 */
export class ExternalPackDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalPackDriftError";
  }
}
