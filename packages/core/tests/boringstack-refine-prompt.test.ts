import { describe, it, expect } from "bun:test";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { ISlice } from "../src/loop/planning/plan-types";
import { refinePrompt } from "../src/loop/boringstack/refine-prompt";

describe("refinePrompt", () => {
  it("contains the resource id", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record with line items and payment tracking",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("Invoice");
  });

  it("leads with the prior gate errors on a retry (lastError)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 1,
      lastError: "project.routes.ts:12 error TS2304: Cannot find name 'foo'",
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("PREVIOUS attempt FAILED");
    expect(prompt).toContain("TS2304: Cannot find name 'foo'");
  });

  it("omits the failure block on a first attempt (no lastError)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    expect(refinePrompt(feature)).not.toContain("PREVIOUS attempt FAILED");
  });

  it("contains the resource description", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record with line items and payment tracking",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain(
      "Customer billing record with line items and payment tracking"
    );
  });

  it("contains the API schema file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.schemas.ts");
  });

  it("instructs adding real domain columns to the entity's Drizzle table", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // The model must be told to add columns to the shared schema, and to touch
    // ONLY its own table — this is what makes persistence real, not in-memory.
    expect(prompt).toContain(
      "apps/api/src/clients/postgres/schema/app.schema.ts"
    );
    expect(prompt).toContain("invoice");
    expect(prompt.toLowerCase()).toContain("persist");
    expect(prompt).toMatch(/do not touch any other table/iu);
  });

  it("instructs adding i18n keys for every UI string to the locale files", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("i18n");
    expect(prompt).toContain("locales");
    expect(prompt).toContain("features.invoice");
    expect(prompt.toLowerCase()).toContain("parity");
  });

  it("contains the API service file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.service.ts");
  });

  it("contains the API types file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.types.ts");
  });

  it("contains the UI feature path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/ui/src/features/invoice");
  });

  it("contains the required test sibling paths", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain(
      "apps/api/tests/api/invoice/invoice.routes.test.ts"
    );
    expect(prompt).toContain(
      "apps/api/tests/api/invoice/invoice.service.test.ts"
    );
  });

  it("contains freeze wording", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("freeze");
  });

  it("contains domain-fill instructions about real fields", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("field");
  });

  it("contains guidance against as casts", () => {
    const feature: IFeature = {
      id: "Customer",
      desc: "End user or organization",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("as");
  });

  it("uses correct camelCase conversion", () => {
    const feature: IFeature = {
      id: "PaymentMethod",
      desc: "Payment storage and retrieval",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("paymentMethod");
    expect(prompt).toContain("apps/api/src/api/paymentMethod/paymentMethod");
  });

  it("refinePrompt injects the slice's fields, UI intent, and contract when given a plan slice", () => {
    const feature: IFeature = {
      id: "Bookmark",
      desc: "a link",
      passes: false,
      attempts: 0,
    };
    const slice: ISlice = {
      entity: {
        id: "Bookmark",
        desc: "a link",
        fields: [{ name: "description", type: "string", optional: true }],
        relationships: ["belongsTo User"],
        rules: ["url required"],
      },
      ui: {
        screens: ["list", "form"],
        action: "save → list",
        shows: ["url", "description"],
        nav: "Bookmarks",
      },
      verification: {
        mustRemainTrue: ["auth"],
        mustNotHappen: ["no url"],
        acceptanceCheck: "bun test",
      },
    };
    const p = refinePrompt(feature, slice);

    expect(p).toContain("description"); // the field it kept dropping
    expect(p).toContain("belongsTo User");
    expect(p).toContain("save → list"); // UI intent
    expect(p).toContain("url required"); // rule
  });

  it("refinePrompt without a slice is unchanged (contains id + desc)", () => {
    const p = refinePrompt({
      id: "Bookmark",
      desc: "a link",
      passes: false,
      attempts: 0,
    });

    expect(p).toContain("Bookmark");
  });
});
