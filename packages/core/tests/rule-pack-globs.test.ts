import { test, expect, describe } from "bun:test";
import { matchesGlobPattern } from "../src/rule-packs/utils";

describe("matchesGlobPattern", () => {
  test("exact path and trailing /** directory trees", () => {
    expect(matchesGlobPattern("src/cli.ts", "src/cli.ts")).toBe(true);
    expect(matchesGlobPattern("src/api/handler.ts", "src/cli.ts")).toBe(false);
    expect(
      matchesGlobPattern("src/config/env/index.ts", "src/config/env/**")
    ).toBe(true);
    expect(matchesGlobPattern("src/config/env.ts", "src/config/env/**")).toBe(
      false
    );
  });

  test("leading **/ matches nested and root files", () => {
    expect(matchesGlobPattern("src/foo.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesGlobPattern("foo.test.ts", "**/*.test.ts")).toBe(true);
    expect(
      matchesGlobPattern("drizzle/migrations/001.ts", "**/migrations/**")
    ).toBe(true);
    expect(matchesGlobPattern("src/oauth/state.ts", "**/oauth/state.ts")).toBe(
      true
    );
    expect(
      matchesGlobPattern("src/oauth/providers/x.ts", "**/oauth/providers/**")
    ).toBe(true);
    expect(
      matchesGlobPattern(
        "apps/db/schema/users.schema.ts",
        "**/schema/**/*.schema.ts"
      )
    ).toBe(true);
  });

  test("brace expansion before escaping", () => {
    expect(
      matchesGlobPattern("next.config.ts", "**/*.config.{ts,js,mjs}")
    ).toBe(true);
    expect(
      matchesGlobPattern("vitest.config.mjs", "**/*.config.{ts,js,mjs}")
    ).toBe(true);
    expect(
      matchesGlobPattern("next.config.cjs", "**/*.config.{ts,js,mjs}")
    ).toBe(false);
  });
});
