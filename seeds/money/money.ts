export type Currency = "USD" | "EUR" | "GBP";

export interface IMoney {
  readonly cents: number;
  readonly currency: Currency;
}

const SYMBOLS: Record<Currency, string> = { USD: "$", EUR: "€", GBP: "£" };

/**
 * A currency-safe money value. Stored as integer minor units (cents) so decimal
 * arithmetic never drifts, and operations between different currencies are
 * rejected rather than silently producing nonsense.
 */
export class Money implements IMoney {
  private constructor(
    readonly cents: number,
    readonly currency: Currency
  ) {}

  static fromCents(cents: number, currency: Currency): Money {
    if (!Number.isInteger(cents)) {
      throw new Error(`cents must be a whole number, got ${cents}`);
    }

    return new Money(cents, currency);
  }

  static fromAmount(amount: number, currency: Currency): Money {
    return new Money(Math.round(amount * 100), currency);
  }

  /** Parse a formatted string: grouping, currency symbols, a leading minus, or
   *  accounting-style `(1,234.56)` parentheses for negatives. */
  static parse(text: string, currency: Currency): Money {
    const trimmed = text.trim();
    const isParenNegative = /^\(.*\)$/.test(trimmed);
    const cleaned = trimmed.replace(/[()$€£,\s]/g, "");
    const value = Number(cleaned);

    if (cleaned.length === 0 || Number.isNaN(value)) {
      throw new Error(`cannot parse money from "${text}"`);
    }

    const signed = isParenNegative ? -Math.abs(value) : value;

    return Money.fromAmount(signed, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents - other.cents, this.currency);
  }

  times(factor: number): Money {
    return new Money(Math.round(this.cents * factor), this.currency);
  }

  /**
   * Split this amount across integer weights so the parts sum EXACTLY to the
   * total — leftover cents are handed out one at a time to the earliest buckets
   * (and negative leftovers taken back the same way). No cent is created or lost.
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new Error("allocate needs at least one weight");
    }

    const total = weights.reduce((sum, weight) => sum + weight, 0);

    if (total <= 0) {
      throw new Error("allocate weights must sum to a positive value");
    }

    const parts: number[] = [];
    let remainder = this.cents;

    for (const weight of weights) {
      const share = Math.trunc((this.cents * weight) / total);

      parts.push(share);
      remainder -= share;
    }

    const step = remainder >= 0 ? 1 : -1;
    let index = 0;

    while (remainder !== 0) {
      const current = parts[index];

      if (current !== undefined) {
        parts[index] = current + step;
        remainder -= step;
      }

      index = (index + 1) % parts.length;
    }

    return parts.map((cents) => new Money(cents, this.currency));
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }

  toString(): string {
    const isNegative = this.cents < 0;
    const abs = Math.abs(this.cents);
    const whole = Math.trunc(abs / 100).toLocaleString("en-US");
    const fraction = String(abs % 100).padStart(2, "0");

    return `${isNegative ? "-" : ""}${SYMBOLS[this.currency]}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(
        `currency mismatch: ${this.currency} vs ${other.currency}`
      );
    }
  }
}
