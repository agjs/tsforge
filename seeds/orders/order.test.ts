import { describe, expect, it } from "bun:test";
import type { IProduct } from "./types";
import { lineDiscountCents, lineNetCents } from "./pricing";
import { taxCents } from "./tax";
import { summarizeOrder } from "./order";

const widget: IProduct = {
  sku: "WIDGET",
  name: "Widget",
  unitPriceCents: 1000,
  taxable: true,
};

const ebook: IProduct = {
  sku: "EBOOK",
  name: "E-book",
  unitPriceCents: 500,
  taxable: false,
};

describe("pricing", () => {
  it("applies a percentage discount, rounded to the nearest cent", () => {
    expect(
      lineDiscountCents({
        product: widget,
        quantity: 1,
        discount: { kind: "percent", rate: 0.1 },
      })
    ).toBe(100);
  });

  it("clamps a fixed discount to the line subtotal", () => {
    expect(
      lineDiscountCents({
        product: widget,
        quantity: 1,
        discount: { kind: "fixed", amountCents: 1500 },
      })
    ).toBe(1000);
  });

  it("treats bogo as every second unit free", () => {
    expect(
      lineDiscountCents({
        product: widget,
        quantity: 3,
        discount: { kind: "bogo" },
      })
    ).toBe(1000);
    expect(
      lineNetCents({
        product: widget,
        quantity: 3,
        discount: { kind: "bogo" },
      })
    ).toBe(2000);
  });
});

describe("tax", () => {
  it("charges no sales tax in Oregon", () => {
    expect(taxCents(2000, "US-OR")).toBe(0);
  });

  it("rounds California sales tax to the nearest cent", () => {
    expect(taxCents(1000, "US-CA")).toBe(73);
  });
});

describe("summarizeOrder", () => {
  it("sums a simple tax-free order", () => {
    const summary = summarizeOrder(
      [{ product: widget, quantity: 2 }],
      "US-OR"
    );

    expect(summary).toEqual({
      subtotalCents: 2000,
      discountCents: 0,
      taxableBaseCents: 2000,
      taxCents: 0,
      totalCents: 2000,
    });
  });

  it("taxes the discounted net of taxable lines only", () => {
    const summary = summarizeOrder(
      [
        {
          product: widget,
          quantity: 1,
          discount: { kind: "percent", rate: 0.1 },
        },
        { product: ebook, quantity: 1 },
      ],
      "US-CA"
    );

    expect(summary.subtotalCents).toBe(1500);
    expect(summary.discountCents).toBe(100);
    expect(summary.taxableBaseCents).toBe(900);
    expect(summary.taxCents).toBe(65);
    expect(summary.totalCents).toBe(1465);
  });

  it("applies EU VAT to the whole taxable base", () => {
    const summary = summarizeOrder([{ product: widget, quantity: 1 }], "EU-DE");

    expect(summary.taxCents).toBe(190);
    expect(summary.totalCents).toBe(1190);
  });
});
