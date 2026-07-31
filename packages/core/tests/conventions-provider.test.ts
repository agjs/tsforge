import { test, expect } from "bun:test";
import type { IConventionProvider } from "../src/loop/conventions-provider";
import { boringstackConventionProvider } from "../src/loop/conventions";

// Mirrored test for the IConventionProvider seam (loop/conventions-provider.ts). The interface is
// type-only, so this pins its CONTRACT via the concrete BoringStack implementation: assignability
// (a compile-time check the const annotation enforces) plus a real, non-empty guide body — so an
// empty/wrong provider can't slip through claiming to satisfy the seam.
test("boringstackConventionProvider satisfies IConventionProvider with real guide content", () => {
  const provider: IConventionProvider = boringstackConventionProvider;
  const guides = provider.buildGuides();

  expect(guides.length).toBeGreaterThan(0);
  expect(guides).toContain("HOW THIS STACK WRITES CODE");
});
