import { describe, it, expect } from "bun:test";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
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
});
