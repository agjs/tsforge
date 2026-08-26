/**
 * Top-right chrome while a turn is in flight must not paint idle `✓`.
 * `drive()` used to be the only spinner path; Phaser approve / planner skipped it.
 */
export function resolveChromeStatus(opts: {
  readonly busy: boolean;
  readonly lastStatus: string;
  readonly activity: string;
}): { readonly status: string; readonly activity?: string } {
  if (!opts.busy) {
    return opts.activity.length > 0
      ? { status: opts.lastStatus, activity: opts.activity }
      : { status: opts.lastStatus };
  }

  const activity = opts.activity.length > 0 ? opts.activity : "working";
  const idle =
    opts.lastStatus === "ready" ||
    opts.lastStatus === "done" ||
    opts.lastStatus === "responded";

  return {
    status: idle ? "working" : opts.lastStatus,
    activity,
  };
}
