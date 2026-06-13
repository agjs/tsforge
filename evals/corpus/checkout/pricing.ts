// RED stub: the spec drives the agent to implement this correctly.

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function calculateDiscount(
  subtotalCents: number,
  percentOff: number
): number {
  const discountAmount = (subtotalCents * percentOff) / 100;
  return roundHalfUp(discountAmount);
}

export function applyFixedDiscount(
  amountCents: number,
  discountCents: number
): number {
  return Math.min(discountCents, amountCents);
}

export function calculateTax(amountCents: number, taxRatePpm: number): number {
  const taxAmount = (amountCents * taxRatePpm) / 1000000;
  return roundHalfUp(taxAmount);
}
