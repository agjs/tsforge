import { test, expect } from "bun:test";
import type { IConventionProvider } from "../src/loop/conventions-provider";
import {
  phaserConventionProvider,
  PHASER_TOPIC_RULES,
} from "../src/loop/phaser/conventions";

test("phaserConventionProvider satisfies IConventionProvider with real guides", () => {
  const provider: IConventionProvider = phaserConventionProvider;
  const guides = provider.buildGuides();

  expect(guides.length).toBeGreaterThan(0);
  expect(guides).toContain("pull-before-first-write");
  expect(provider.topics()).toEqual([
    "domain-purity",
    "scene-shutdown",
    "no-tick-alloc",
    "branded-keys",
    "composition",
    "content-catalog",
  ]);
  expect(provider.guide("domain-purity")).toContain("must not import phaser");
  expect(provider.guide("nope")).toBeNull();
});

test("topic rules name real Phaser pack rule ids (bare names)", () => {
  expect(PHASER_TOPIC_RULES["domain-purity"]).toContain(
    "no-phaser-import-in-pure-layers"
  );
  expect(PHASER_TOPIC_RULES["no-tick-alloc"]).toContain(
    "no-phaser-alloc-in-update"
  );
});

test("unseenForErrors maps a pack rule onto its guide once", () => {
  const seen = new Set<string>();
  const first = phaserConventionProvider.unseenForErrors(
    [{ rule: "phaser/no-phaser-import-in-pure-layers" }],
    seen
  );

  expect(first.length).toBe(1);
  expect(first[0]).toContain("DOMAIN PURITY");
  expect(
    phaserConventionProvider.unseenForErrors(
      [{ rule: "phaser/no-phaser-import-in-pure-layers" }],
      seen
    )
  ).toEqual([]);
});
