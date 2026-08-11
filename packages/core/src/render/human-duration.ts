/**
 * Compact elapsed time for status chrome / spinner: seconds, then minutes,
 * then hours. 1500s → `25m00s`, 3661s → `1h01m01s` — never a raw multi-digit
 * second count that forces mental division.
 */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));

  if (total < 60) {
    return `${String(total)}s`;
  }

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const sec = String(seconds).padStart(2, "0");

  if (hours === 0) {
    return `${String(minutes)}m${sec}s`;
  }

  const min = String(minutes).padStart(2, "0");

  return `${String(hours)}h${min}m${sec}s`;
}
