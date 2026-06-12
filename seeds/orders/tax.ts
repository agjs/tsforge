import type { Region } from "./types";

const RATES: Record<Region, number> = {
  "US-CA": 0.0725,
  "US-OR": 0,
  "EU-DE": 0.19,
};

export function taxRate(region: Region): number {
  return RATES[region];
}

export function taxCents(taxableBaseCents: number, region: Region): number {
  return Math.round(taxableBaseCents * taxRate(region));
}
