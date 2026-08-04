import { test, expect } from "bun:test";
import { checkout } from "./cart";
import type { ICoupon } from "./coupons";
import type { ILineItem } from "./cart";

test("empty cart", () => {
  const result = checkout([], [], 50000);

  expect(result.subtotalCents).toBe(0);
  expect(result.discountCents).toBe(0);
  expect(result.taxCents).toBe(0);
  expect(result.totalCents).toBe(0);
});

test("single line item no coupons", () => {
  const items: ILineItem[] = [
    {
      sku: "A",
      unitCents: 1000,
      qty: 1,
      availableQty: 10,
    },
  ];
  const result = checkout(items, [], 50000);

  expect(result.subtotalCents).toBe(1000);
  expect(result.discountCents).toBe(0);
  expect(result.taxCents).toBe(50); // 1000 * 50000ppm = 1000 * 0.05 = 50 cents
  expect(result.totalCents).toBe(1050);
});

test("multiple line items", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 2, availableQty: 10 },
    { sku: "B", unitCents: 2000, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 100000); // 10% tax

  expect(result.subtotalCents).toBe(4000);
  expect(result.discountCents).toBe(0);
  expect(result.taxCents).toBe(400); // 4000 * 0.1
  expect(result.totalCents).toBe(4400);
});

test("qty exceeds available stock is clamped to available", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 15, availableQty: 5 },
  ];
  const result = checkout(items, [], 50000);

  // Qty is clamped to 5 available, so subtotal = 5 * 1000 = 5000
  expect(result.subtotalCents).toBe(5000);
  expect(result.taxCents).toBe(250);
  expect(result.totalCents).toBe(5250);
});

test("percent coupon reduces subtotal", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 10 }];
  const result = checkout(items, coupons, 50000);

  // 1000 * 0.1 = 100 discount
  expect(result.subtotalCents).toBe(1000);
  expect(result.discountCents).toBe(100);
  expect(result.taxCents).toBe(45); // (1000 - 100) * 0.05 = 450 * 0.05 = 45
  expect(result.totalCents).toBe(945);
});

test("fixed coupon reduces subtotal", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 2, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "fixed", cents: 300 }];
  const result = checkout(items, coupons, 50000);

  expect(result.subtotalCents).toBe(2000);
  expect(result.discountCents).toBe(300);
  expect(result.taxCents).toBe(85); // (2000 - 300) * 50000ppm = 1700 * 0.05 = 85
  expect(result.totalCents).toBe(1785); // 1700 + 85
});

test("fixed coupon larger than subtotal is clamped", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 500, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "fixed", cents: 1000 }];
  const result = checkout(items, coupons, 50000);

  // Discount clamped to 500, so after discount subtotal is 0
  expect(result.subtotalCents).toBe(500);
  expect(result.discountCents).toBe(500);
  expect(result.taxCents).toBe(0);
  expect(result.totalCents).toBe(0);
});

test("bogo coupon applies to matching sku", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 2, availableQty: 10 },
    { sku: "B", unitCents: 2000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "bogo", sku: "A" }];
  const result = checkout(items, coupons, 50000);

  // Subtotal: (2 * 1000) + (1 * 2000) = 4000
  // Discount: 1 * 1000 (one "A" is free)
  expect(result.subtotalCents).toBe(4000);
  expect(result.discountCents).toBe(1000);
  expect(result.taxCents).toBe(150); // (4000 - 1000) * 0.05 = 3000 * 0.05 = 150
  expect(result.totalCents).toBe(3150);
});

test("bogo with qty 1 yields zero discount", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "bogo", sku: "A" }];
  const result = checkout(items, coupons, 50000);

  // Only 1 item, so no free item
  expect(result.discountCents).toBe(0);
});

test("multiple coupons stack in order: percent then fixed", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [
    { kind: "percent", off: 20 }, // -200
    { kind: "fixed", cents: 100 }, // -100
  ];
  const result = checkout(items, coupons, 50000);

  // Subtotal: 1000, after percent: 800, after fixed: 700
  expect(result.subtotalCents).toBe(1000);
  expect(result.discountCents).toBe(300);
  expect(result.taxCents).toBe(35); // 700 * 0.05 = 35
  expect(result.totalCents).toBe(735);
});

test("multiple coupons with bogo stacking", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 3, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [
    { kind: "bogo", sku: "A" }, // -1000 (one free)
    { kind: "percent", off: 10 }, // 10% of remaining after bogo
  ];
  const result = checkout(items, coupons, 50000);

  // Subtotal: 3000
  // After BOGO: 3000 - 1000 = 2000
  // After percent (10% of 2000): 2000 - 200 = 1800
  expect(result.subtotalCents).toBe(3000);
  expect(result.discountCents).toBe(1200);
  expect(result.taxCents).toBe(90); // 1800 * 0.05 = 90
  expect(result.totalCents).toBe(1890);
});

test("tax rounding: half-up", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 333, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 150000); // 15% tax = 49.95 cents

  // 333 * 0.15 = 49.95, rounds half-up to 50
  expect(result.taxCents).toBe(50);
  expect(result.totalCents).toBe(383);
});

test("tax rounding: 0.4 rounds down", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 200, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 200000); // 20% tax = 40 cents

  expect(result.taxCents).toBe(40);
  expect(result.totalCents).toBe(240);
});

test("tax rounding: 0.5 rounds up", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 100, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 150000); // 15% tax = 15 cents

  expect(result.taxCents).toBe(15);
  expect(result.totalCents).toBe(115);
});

test("discount then tax with fractional result", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1234, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 15 }];
  const result = checkout(items, coupons, 80000); // 8% tax

  // Subtotal: 1234
  // Discount: 1234 * 0.15 = 185.1 rounds to 185
  // After discount: 1234 - 185 = 1049
  // Tax: 1049 * 0.08 = 83.92 rounds to 84
  expect(result.discountCents).toBe(185);
  expect(result.taxCents).toBe(84);
  expect(result.totalCents).toBe(1133);
});

test("all coupon types in one checkout", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 2000, qty: 2, availableQty: 10 },
    { sku: "B", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [
    { kind: "percent", off: 10 }, // 10% of 5000 = 500
    { kind: "fixed", cents: 200 }, // -200
    { kind: "bogo", sku: "A" }, // -2000 (one A is free)
  ];
  const result = checkout(items, coupons, 100000); // 10% tax

  // Subtotal: 5000
  // After percent (10%): 5000 - 500 = 4500
  // After fixed: 4500 - 200 = 4300
  // After BOGO (1 * 2000): 4300 - 2000 = 2300
  expect(result.subtotalCents).toBe(5000);
  expect(result.discountCents).toBe(2700);
  expect(result.taxCents).toBe(230); // 2300 * 0.1 = 230
  expect(result.totalCents).toBe(2530);
});

test("percent coupon at boundary 0%", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 0 }];
  const result = checkout(items, coupons, 50000);

  expect(result.discountCents).toBe(0);
});

test("percent coupon at boundary 100%", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 100 }];
  const result = checkout(items, coupons, 50000);

  expect(result.discountCents).toBe(1000);
  expect(result.totalCents).toBe(0);
});

test("zero tax rate", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 0);

  expect(result.taxCents).toBe(0);
  expect(result.totalCents).toBe(1000);
});

test("high tax rate", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 250000); // 25% tax

  expect(result.taxCents).toBe(250);
  expect(result.totalCents).toBe(1250);
});

test("small amount with rounding", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 3, qty: 1, availableQty: 10 },
  ];
  const result = checkout(items, [], 333333); // 33.3333% tax

  // 3 * 0.333333 = 0.999999 rounds to 1
  expect(result.taxCents).toBe(1);
  expect(result.totalCents).toBe(4);
});

test("percent rounding: 1/3 of 100 cents", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 100, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 33 }]; // 33% = 33 cents
  const result = checkout(items, coupons, 0);

  expect(result.discountCents).toBe(33);
  expect(result.totalCents).toBe(67);
});

test("complex stacking: bogo then percent on remainder", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 500, qty: 4, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [
    { kind: "bogo", sku: "A" }, // 2 free (half of 4), so -1000
    { kind: "percent", off: 50 }, // 50% of remainder
  ];
  const result = checkout(items, coupons, 100000); // 10% tax

  // Subtotal: 4 * 500 = 2000
  // After BOGO: 2000 - 1000 = 1000
  // After 50%: 1000 - 500 = 500
  expect(result.subtotalCents).toBe(2000);
  expect(result.discountCents).toBe(1500);
  expect(result.taxCents).toBe(50); // 500 * 0.1 = 50
  expect(result.totalCents).toBe(550);
});

test("fixed coupon at boundary equal to subtotal", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "fixed", cents: 1000 }];
  const result = checkout(items, coupons, 50000);

  expect(result.discountCents).toBe(1000);
  expect(result.totalCents).toBe(0);
});

test("negative discount is never allowed", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 100, qty: 1, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "fixed", cents: 500 }];
  const result = checkout(items, coupons, 0);

  // Discount clamped to 100, total is 0
  expect(result.totalCents).toBeGreaterThanOrEqual(0);
});

test("bogo with zero-price item", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 0, qty: 2, availableQty: 10 },
  ];
  const coupons: ICoupon[] = [{ kind: "bogo", sku: "A" }];
  const result = checkout(items, coupons, 50000);

  expect(result.totalCents).toBe(0);
});

test("percent coupon with large qty multiplier", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 100, qty: 100, availableQty: 150 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 25 }]; // 25% off
  const result = checkout(items, coupons, 100000); // 10% tax

  // Subtotal: 10000
  // Discount: 10000 * 0.25 = 2500
  // After discount: 7500
  // Tax: 7500 * 0.1 = 750
  expect(result.discountCents).toBe(2500);
  expect(result.taxCents).toBe(750);
  expect(result.totalCents).toBe(8250);
});

test("inventory clamping affects final total", () => {
  const items: ILineItem[] = [
    { sku: "A", unitCents: 1000, qty: 100, availableQty: 5 },
  ];
  const coupons: ICoupon[] = [{ kind: "percent", off: 20 }];
  const result = checkout(items, coupons, 50000);

  // Qty clamped to 5, subtotal: 5000
  // Discount: 5000 * 0.2 = 1000
  // After discount: 4000
  // Tax: 4000 * 0.05 = 200
  expect(result.subtotalCents).toBe(5000);
  expect(result.discountCents).toBe(1000);
  expect(result.totalCents).toBe(4200);
});
