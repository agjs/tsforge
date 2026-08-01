import { test, expect } from "bun:test";
import type { IConventionProvider } from "../src/loop/conventions-provider";
import { boringstackConventionProvider } from "../src/loop/boringstack/conventions";

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

test("the provider's guide/topics/unseenForErrors return real content (not stubs)", () => {
  const provider: IConventionProvider = boringstackConventionProvider;

  // topics() lists real topics; guide() returns the pattern for one of them.
  const topics = provider.topics();

  expect(topics).toContain("no-casts");
  expect(provider.guide("no-casts")).toContain("TYPE GUARD");
  expect(provider.guide("nope-not-a-topic")).toBeNull();

  // unseenForErrors() maps a gate error's rule to its guide, deduping via `seen`.
  const seen = new Set<string>();
  const first = provider.unseenForErrors(
    [{ rule: "no-restricted-syntax" }],
    seen
  );

  expect(first.length).toBeGreaterThan(0);
  // Same rule again ⇒ deduped (already seen this run).
  expect(
    provider.unseenForErrors([{ rule: "no-restricted-syntax" }], seen)
  ).toEqual([]);
});
