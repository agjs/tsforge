import { test, expect, describe } from "bun:test";
import {
  buildMetaBaseline,
  subtractMetaBaseline,
} from "../src/meta-rules/baseline";
import type { IMetaRuleViolation } from "../src/meta-rules";

const v = (
  file: string,
  ruleId: string,
  message: string,
  severity: "error" | "warn" = "warn"
): IMetaRuleViolation => ({ file, ruleId, severity, message });

describe("subtractMetaBaseline (counted multiset differential)", () => {
  test("undefined baseline is a no-op — every violation survives", () => {
    const cur = [v("a.ts", "r", "m")];

    expect(subtractMetaBaseline(cur, undefined)).toEqual(cur);
  });

  test("a pre-existing violation is suppressed once", () => {
    const baseline = buildMetaBaseline([
      v("a.ts", "lockfile-required", "no lockfile"),
    ]);
    const cur = [v("a.ts", "lockfile-required", "no lockfile")];

    expect(subtractMetaBaseline(cur, baseline)).toEqual([]);
  });

  test("a NEWLY-INTRODUCED duplicate of a baselined key still surfaces (count-based)", () => {
    // Pristine had ONE; the model's work introduced a SECOND identical one.
    const baseline = buildMetaBaseline([v("a.ts", "r", "dup")]);
    const cur = [v("a.ts", "r", "dup"), v("a.ts", "r", "dup")];

    const kept = subtractMetaBaseline(cur, baseline);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.message).toBe("dup");
  });

  test("a violation that differs in message is NOT suppressed", () => {
    const baseline = buildMetaBaseline([v("a.ts", "r", "old message")]);
    const cur = [v("a.ts", "r", "a NEW message the model caused")];

    expect(subtractMetaBaseline(cur, baseline)).toEqual(cur);
  });

  test("suppresses only matching keys, keeps the rest", () => {
    const baseline = buildMetaBaseline([
      v(".github/workflows/x.yml", "l-least-privilege", "contents write"),
      v("package.json", "lockfile-required", "no lockfile"),
    ]);
    const cur = [
      v(".github/workflows/x.yml", "l-least-privilege", "contents write"), // pre-existing
      v("src/feature.ts", "no-explicit-any", "the model's own new violation"), // new
    ];

    const kept = subtractMetaBaseline(cur, baseline);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.ruleId).toBe("no-explicit-any");
  });
});
