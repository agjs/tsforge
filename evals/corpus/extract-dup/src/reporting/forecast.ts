/** Half-EVEN (banker's) rounding — deliberately NOT the same as the half-up
 *  helper the other modules share. Ties go to the nearest even value. */
function roundHalfEven(cents: number, factor: number): number {
  const scaled = cents / factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;

  if (diff > 0.5) {
    return floor + 1;
  }

  if (diff < 0.5) {
    return floor;
  }

  return floor % 2 === 0 ? floor : floor + 1;
}

export function forecastTotal(
  samples: readonly number[],
  factor: number
): number {
  const sum = samples.reduce((acc, n) => acc + n, 0);

  return roundHalfEven(sum, factor);
}
