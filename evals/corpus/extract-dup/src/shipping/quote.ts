/** Half-up rounding, away from zero. */
function round(cents: number, factor: number): number {
  const scaled = cents / factor;

  return scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5);
}

export function shippingQuote(legs: readonly number[], factor: number): number {
  const sum = legs.reduce((acc, n) => acc + n, 0);

  return round(sum, factor);
}
