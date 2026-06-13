// RED stub: the spec drives the agent to implement this correctly.

import type { ICoupon } from "./coupons";
import { applyCoupons } from "./coupons";
import { calculateTax } from "./pricing";

export interface ILineItem {
  sku: string;
  unitCents: number;
  qty: number;
  availableQty: number;
}

export interface ICheckoutResult {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export function checkout(
  items: ILineItem[],
  coupons: ICoupon[],
  taxRatePpm: number
): ICheckoutResult {
  const clampedItems = items.map((item) => ({
    ...item,
    qty: Math.min(item.qty, item.availableQty),
  }));

  const lineInfos = clampedItems.map((item) => ({
    sku: item.sku,
    unitCents: item.unitCents,
    qty: item.qty,
  }));

  const subtotalCents = clampedItems.reduce(
    (sum, item) => sum + item.unitCents * item.qty,
    0
  );

  const discountCents = applyCoupons(subtotalCents, coupons, lineInfos);

  const afterDiscountCents = Math.max(0, subtotalCents - discountCents);

  const taxCents = calculateTax(afterDiscountCents, taxRatePpm);

  const totalCents = afterDiscountCents + taxCents;

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents,
  };
}
