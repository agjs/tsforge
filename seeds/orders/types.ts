export type Region = "US-CA" | "US-OR" | "EU-DE";

export interface IProduct {
  readonly sku: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly taxable: boolean;
}

export type Discount =
  | { readonly kind: "percent"; readonly rate: number }
  | { readonly kind: "fixed"; readonly amountCents: number }
  | { readonly kind: "bogo" };

export interface ICartLine {
  readonly product: IProduct;
  readonly quantity: number;
  readonly discount?: Discount;
}

export interface IOrderSummary {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxableBaseCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}
