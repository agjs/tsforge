import { describe, expect, test } from "bun:test";
import {
  conventionPullGate,
  missingConventionTopics,
  pathToConventionTopics,
  houseConventionProvider,
} from "../src/loop/conventions";
import {
  phaserConventionProvider,
  phaserTopicsForPath,
} from "../src/loop/phaser/conventions";

describe("phaserTopicsForPath", () => {
  test("domain module paths pull domain-purity and module-layout, not anatomy", () => {
    const topics = phaserTopicsForPath("src/domain/coin/Coin.behavior.ts");

    expect(topics).toContain("domain-purity");
    expect(topics).toContain("module-layout");
    expect(topics).toContain("no-casts");
    expect(topics).not.toContain("component-anatomy");
  });

  test("scene setup pulls composition, shutdown, no-tick-alloc, branded-keys", () => {
    const topics = phaserTopicsForPath(
      "src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts"
    );

    expect(topics).toContain("composition");
    expect(topics).toContain("scene-shutdown");
    expect(topics).toContain("no-tick-alloc");
    expect(topics).toContain("branded-keys");
  });

  test("a .tsx path does not fire component-anatomy through Phaser", () => {
    expect(phaserTopicsForPath("src/Foo.tsx")).not.toContain(
      "component-anatomy"
    );
    expect(
      pathToConventionTopics("src/Foo.tsx", houseConventionProvider.topics())
    ).toContain("component-anatomy");
  });
});

describe("Phaser convention pull gate", () => {
  test("rejects a first write to Coin.behavior.ts until domain-purity is pulled", () => {
    const ctx = {
      conventions: phaserConventionProvider,
      touched: new Set<string>(),
      pulledTopics: new Set<string>(),
    };
    const msg = conventionPullGate("src/domain/coin/Coin.behavior.ts", ctx);

    expect(msg).toContain("requires conventions you have not read");
    expect(msg).toContain("domain-purity");
    expect(msg).toContain("=== CONVENTION: domain-purity ===");
    expect(ctx.pulledTopics.has("domain-purity")).toBe(true);
    expect(
      conventionPullGate("src/domain/coin/Coin.behavior.ts", ctx)
    ).toBeNull();
  });

  test("scene setup cannot be written without composition / shutdown", () => {
    const missing = missingConventionTopics(
      "src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts",
      {
        conventionsActive: true,
        touched: new Set(),
        pulledTopics: new Set(),
        availableTopics: phaserConventionProvider.topics(),
        topicsForPath: phaserTopicsForPath,
      }
    );

    expect(missing).toContain("composition");
    expect(missing).toContain("scene-shutdown");
    expect(missing).toContain("no-tick-alloc");
  });

  test("buildGuides prints the Phaser path map from topicsForPath, not React probes", () => {
    const contract = phaserConventionProvider.buildGuides();

    expect(contract).toContain("src/domain/**");
    expect(contract).toContain("src/runtime/phaser/scenes/**");
    expect(contract).toContain("module-layout");
    expect(contract).not.toContain("*.tsx →");
    expect(contract).not.toContain("FILE PURITY");
  });
});
