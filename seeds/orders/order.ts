import type { ICartLine, IOrderSummary, Region } from "./types";
import { lineSubtotalCents, lineDiscountCents, lineNetCents } from "./pricing";
import { taxCents } from "./tax";

/**
 * Roll a cart up into an order summary. Tax applies only to the discounted
 * (net) total of taxable lines; the order total is subtotal − discount + tax.
 */
export function summarizeOrder(
  lines: readonly ICartLine[],
  region: Region
): IOrderSummary {
  let subtotalCents = 0;
  let discountCents = 0;
  let taxableBaseCents = 0;

  for (const line of lines) {
    subtotalCents += lineSubtotalCents(line);
    discountCents += lineDiscountCents(line);

    if (line.product.taxable) {
      taxableBaseCents += lineNetCents(line);
    }
  }

  const tax = taxCents(taxableBaseCents, region);

  return {
    subtotalCents,
    discountCents,
    taxableBaseCents,
    taxCents: tax,
    totalCents: subtotalCents - discountCents + tax,
  };
}
