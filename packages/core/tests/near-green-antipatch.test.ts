import { describe, expect, test } from "bun:test";
import {
  ANTI_PATCH_NEAR_GREEN_STEER,
  antiPatchNearGreenLead,
  looksLikePatchUntilGreen,
} from "../src/loop/near-green-antipatch";
import type { IErrorItem } from "../src/validate/validate.types";

function err(key: string): IErrorItem {
  return { key, message: key };
}

describe("near-green anti-patch", () => {
  test("looksLikePatchUntilGreen needs near-green count + aged key", () => {
    const ages = new Map([["a", 3]]);

    expect(looksLikePatchUntilGreen(ages, [err("a")])).toBe(true);
    expect(looksLikePatchUntilGreen(ages, [err("a")], 3, 5)).toBe(false);
    expect(
      looksLikePatchUntilGreen(ages, [err("a"), err("b"), err("c"), err("d")])
    ).toBe(false);
    expect(looksLikePatchUntilGreen(new Map([["a", 2]]), [err("a")])).toBe(
      false
    );
  });

  test("lead returns the rewrite steer only when the predicate matches", () => {
    const ages = new Map([["stuck", 4]]);

    expect(antiPatchNearGreenLead(ages, [err("stuck")])).toContain(
      ANTI_PATCH_NEAR_GREEN_STEER.slice(0, 24)
    );
    expect(antiPatchNearGreenLead(ages, [])).toBe("");
  });
});
