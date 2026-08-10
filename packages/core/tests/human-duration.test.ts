import { test, expect, describe } from "bun:test";
import { humanDuration } from "../src/render/human-duration";

describe("humanDuration", () => {
  test("stays in seconds under a minute", () => {
    expect(humanDuration(0)).toBe("0s");
    expect(humanDuration(9000)).toBe("9s");
    expect(humanDuration(59_000)).toBe("59s");
  });

  test("switches to minutes instead of raw multi-digit seconds", () => {
    expect(humanDuration(60_000)).toBe("1m00s");
    expect(humanDuration(84_000)).toBe("1m24s");
    expect(humanDuration(1_500_000)).toBe("25m00s");
    expect(humanDuration(1_486_000)).toBe("24m46s");
  });

  test("switches to hours past an hour", () => {
    expect(humanDuration(3_600_000)).toBe("1h00m00s");
    expect(humanDuration(3_661_000)).toBe("1h01m01s");
    expect(humanDuration(7_200_000)).toBe("2h00m00s");
  });
});
