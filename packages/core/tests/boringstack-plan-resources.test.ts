import { test, expect, describe } from "bun:test";
import {
  planResources,
  parseResources,
  dedupeLayerVariants,
} from "../src/loop/boringstack/plan-resources";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";

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
