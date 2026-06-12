import type { ICartLine } from "./types";

export function lineSubtotalCents(line: ICartLine): number {
  return line.product.unitPriceCents * line.quantity;
}

/** The discount applied to a line, clamped so it never exceeds the line subtotal. */
export function lineDiscountCents(line: ICartLine): number {
  const subtotal = lineSubtotalCents(line);
  const { discount } = line;

  if (discount === undefined) {
    return 0;
  }

  switch (discount.kind) {
    case "percent":
      return Math.round(subtotal * discount.rate);
    case "fixed":
      return Math.min(discount.amountCents, subtotal);
    case "bogo": {
      const freeUnits = Math.floor(line.quantity / 2);

      return freeUnits * line.product.unitPriceCents;
    }
  }
}

export function lineNetCents(line: ICartLine): number {
  return lineSubtotalCents(line) - lineDiscountCents(line);
}
