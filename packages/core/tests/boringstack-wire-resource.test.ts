import { test, expect, describe } from "bun:test";
import {
  wireRoutesFile,
  wireAppFile,
  wireSwaggerFile,
} from "../src/loop/boringstack/wire-resource";

describe("wireRoutesFile", () => {
  test("adds import + object entry", () => {
    const src = `import healthRoutes from "../../api/health/health.routes";\n\nexport const routes = {\n  health: healthRoutes,\n};\n`;
    const out = wireRoutesFile(src, "Invoice");

    expect(out).toContain(
      'import invoiceRoutes from "../../api/invoice/invoice.routes";'
    );
    expect(out).toContain("invoice: invoiceRoutes,");
  });
});

describe("wireAppFile", () => {
  test("inserts the group mount", () => {
    const src = `  return (\n    app\n      .use(routes.health)\n  );\n`;

    expect(wireAppFile(src, "Invoice")).toContain(
      '.group("/api/v1/invoice", (group) => group.use(routes.invoice))'
    );
  });
});

describe("wireSwaggerFile", () => {
  test("adds a tag", () => {
    const src = `    tags: [\n      { name: "Health", description: "probes" },\n    ],\n`;

    expect(wireSwaggerFile(src, "Invoice")).toContain(
      '{ name: "Invoice", description: "Invoice resource" }'
    );
  });
});
