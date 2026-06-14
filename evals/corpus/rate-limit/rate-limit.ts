// RED stub: the spec drives the agent to implement this correctly.
export interface IRateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(
  _limit: number,
  _windowMs: number,
  _now: () => number
): IRateLimiter {
  return { allow: () => false };
}
