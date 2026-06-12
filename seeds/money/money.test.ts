import { describe, expect, it } from "bun:test";
import { Money } from "./money";

describe("Money", () => {
  it("constructs from cents and rejects fractional cents", () => {
    expect(Money.fromCents(150, "USD").cents).toBe(150);
    expect(() => Money.fromCents(1.5, "USD")).toThrow();
  });

  it("builds from a decimal amount without float drift", () => {
    const sum = Money.fromAmount(0.1, "USD").add(Money.fromAmount(0.2, "USD"));

    expect(sum.cents).toBe(30);
  });

  it("parses grouped, symbol-prefixed, and parenthesised-negative strings", () => {
    expect(Money.parse("$1,234.56", "USD").cents).toBe(123456);
    expect(Money.parse("(1,234.56)", "USD").cents).toBe(-123456);
    expect(Money.parse("-0.99", "USD").cents).toBe(-99);
  });

  it("throws when the string is not a number", () => {
    expect(() => Money.parse("abc", "USD")).toThrow();
    expect(() => Money.parse("", "USD")).toThrow();
  });

  it("adds and subtracts the same currency", () => {
    const a = Money.fromCents(500, "USD");
    const b = Money.fromCents(150, "USD");

    expect(a.add(b).cents).toBe(650);
    expect(a.subtract(b).cents).toBe(350);
  });

  it("refuses to mix currencies", () => {
    const usd = Money.fromCents(100, "USD");
    const eur = Money.fromCents(100, "EUR");

    expect(() => usd.add(eur)).toThrow();
    expect(() => usd.subtract(eur)).toThrow();
  });

  it("multiplies by a scalar, rounding to the nearest cent", () => {
    expect(Money.fromCents(100, "USD").times(0.075).cents).toBe(8);
    expect(Money.fromCents(1000, "USD").times(1.5).cents).toBe(1500);
  });

  it("allocates evenly with no lost cents (remainder to earliest buckets)", () => {
    const parts = Money.fromCents(100, "USD")
      .allocate([1, 1, 1])
      .map((m) => m.cents);

    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((sum, c) => sum + c, 0)).toBe(100);
  });

  it("allocates by ratio and conserves the total exactly", () => {
    const big = Money.fromCents(1000, "USD")
      .allocate([7, 3])
      .map((m) => m.cents);
    const tricky = Money.fromCents(5, "USD")
      .allocate([3, 7])
      .map((m) => m.cents);

    expect(big).toEqual([700, 300]);
    expect(tricky).toEqual([2, 3]);
    expect(tricky.reduce((sum, c) => sum + c, 0)).toBe(5);
  });

  it("allocates a negative amount without losing cents", () => {
    const parts = Money.fromCents(-100, "USD")
      .allocate([1, 1, 1])
      .map((m) => m.cents);

    expect(parts.reduce((sum, c) => sum + c, 0)).toBe(-100);
  });

  it("formats with grouping, the currency symbol, and a leading sign", () => {
    expect(Money.fromCents(123456, "USD").toString()).toBe("$1,234.56");
    expect(Money.fromCents(-99, "USD").toString()).toBe("-$0.99");
    expect(Money.fromCents(5, "EUR").toString()).toBe("€0.05");
  });

  it("compares value and currency for equality", () => {
    expect(
      Money.fromCents(100, "USD").equals(Money.fromCents(100, "USD"))
    ).toBe(true);
    expect(
      Money.fromCents(100, "USD").equals(Money.fromCents(100, "EUR"))
    ).toBe(false);
  });
});
