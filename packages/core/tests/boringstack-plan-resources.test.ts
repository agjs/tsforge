import { test, expect, describe } from "bun:test";
import {
  planResources,
  parseResources,
  dedupeLayerVariants,
  invalidEntityIds,
} from "../src/loop/boringstack/plan-resources";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { ISlice } from "../src/loop/planning/plan-types";

const slice = (id: string): ISlice => ({
  entity: { id, desc: `${id} desc`, fields: [], relationships: [], rules: [] },
  ui: { screens: ["list"], action: "view", shows: [], nav: id },
  verification: {
    mustRemainTrue: [],
    mustNotHappen: ["x"],
    acceptanceCheck: "x",
  },
});

const feat = (id: string): IFeature => ({
  id,
  desc: `${id} desc`,
  passes: false,
  attempts: 0,
});

const provider = (replies: string[]) => {
  let i = 0;

  return {
    complete: async () => ({ content: replies[i++] ?? "", toolCalls: [] }),
  };
};

describe("planResources", () => {
  test("parses a resource checklist into IFeatures", async () => {
    const p = provider([
      JSON.stringify({
        resources: [
          { id: "Invoice", desc: "invoices CRUD" },
          { id: "Customer", desc: "customers CRUD" },
        ],
      }),
    ]);
    const feats = await planResources(p, "build a billing app");

    expect(feats.map((f) => f.id)).toEqual(["Invoice", "Customer"]);
    expect(feats.every((f) => !f.passes && f.attempts === 0)).toBe(true);
  });

  test("retries once on a malformed first reply", async () => {
    const p = provider([
      "not json",
      JSON.stringify({ resources: [{ id: "Invoice", desc: "x" }] }),
    ]);
    const feats = await planResources(p, "x");

    expect(feats).toHaveLength(1);
  });

  test("drops a <Entity>Service split when the base entity is present", async () => {
    // The exact over-split we watched waste a whole generation cycle.
    const p = provider([
      JSON.stringify({
        resources: [
          { id: "Bookmark", desc: "saved bookmark" },
          { id: "BookmarkService", desc: "bookmark CRUD service" },
        ],
      }),
    ]);
    const feats = await planResources(p, "build a bookmarks app");

    expect(feats.map((f) => f.id)).toEqual(["Bookmark"]);
  });
});

describe("dedupeLayerVariants", () => {
  test("drops layer-suffix variants when the base entity exists", () => {
    const out = dedupeLayerVariants([
      feat("Bookmark"),
      feat("BookmarkService"),
      feat("Invoice"),
      feat("InvoiceApi"),
      feat("InvoiceRoutes"),
    ]);

    expect(out.map((f) => f.id)).toEqual(["Bookmark", "Invoice"]);
  });

  test("keeps a suffixed id when its base entity is NOT present", () => {
    // e.g. a genuine 'AuthService' with no 'Auth' entity stays.
    const out = dedupeLayerVariants([feat("AuthService"), feat("Invoice")]);

    expect(out.map((f) => f.id)).toEqual(["AuthService", "Invoice"]);
  });

  test("parseResources applies the dedup end-to-end", () => {
    const parsed = parseResources(
      JSON.stringify({
        resources: [
          { id: "Order", desc: "an order" },
          { id: "OrderService", desc: "order logic" },
        ],
      })
    );

    expect(parsed?.map((f) => f.id)).toEqual(["Order"]);
  });
});

describe("invalidEntityIds", () => {
  test("returns [] when every entity id is a PascalCase identifier", () => {
    expect(
      invalidEntityIds([slice("Invoice"), slice("PurchaseOrder"), slice("A1")])
    ).toEqual([]);
  });

  test("flags ids that break the identifier contract, preserving order", () => {
    // Each of these becomes file paths / the <camel>Routes identifier / i18n keys, so a
    // non-PascalCase-identifier id (space, hyphen, leading-lowercase, leading digit,
    // symbol) must be rejected up front rather than breaking generation downstream.
    const bad = invalidEntityIds([
      slice("Purchase Order"),
      slice("Good"),
      slice("purchase-order"),
      slice("invoice"),
      slice("2Fast"),
      slice("Wei$rd"),
    ]);

    expect(bad).toEqual([
      "Purchase Order",
      "purchase-order",
      "invoice",
      "2Fast",
      "Wei$rd",
    ]);
  });

  test("returns [] for an empty slice list", () => {
    expect(invalidEntityIds([])).toEqual([]);
  });
});
