// RED stub: the spec drives the agent to implement this correctly.

export type ICoupon =
  | { kind: "percent"; off: number }
  | { kind: "fixed"; cents: number }
  | { kind: "bogo"; sku: string };

interface ILineInfo {
  sku: string;
  unitCents: number;
  qty: number;
}

function applySingleCoupon(
  currentAmount: number,
  coupon: ICoupon,
  lines: ILineInfo[]
): number {
  switch (coupon.kind) {
    case "percent": {
      const discountAmount = Math.floor(
        (currentAmount * coupon.off) / 100 + 0.5
      );
      return Math.min(discountAmount, currentAmount);
    }
    case "fixed": {
      return Math.min(coupon.cents, currentAmount);
    }
    case "bogo": {
      const matchingLine = lines.find((line) => line.sku === coupon.sku);
      if (!matchingLine || matchingLine.qty < 2) {
        return 0;
      }
      const freeQty = Math.floor(matchingLine.qty / 2);
      return freeQty * matchingLine.unitCents;
    }
    default: {
      const _exhaustive: never = coupon;
      return _exhaustive;
    }
  }
}

export function applyCoupons(
  subtotalCents: number,
  coupons: ICoupon[],
  lines: ILineInfo[]
): number {
  let totalDiscount = 0;
  let currentAmount = subtotalCents;

  for (const coupon of coupons) {
    const discountForThisCoupon = applySingleCoupon(
      currentAmount,
      coupon,
      lines
    );
    totalDiscount += discountForThisCoupon;
    currentAmount -= discountForThisCoupon;
  }

  return Math.min(totalDiscount, subtotalCents);
}
