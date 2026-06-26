export function isPositive(v: string): boolean {
  const n = Number(v);

  return Number.isFinite(n) && n > 0;
}
