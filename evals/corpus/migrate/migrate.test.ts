import { expect, test } from "bun:test";
import { run as r1 } from "./svc1";
import { run as r2 } from "./svc2";
import { run as r3 } from "./svc3";
import { run as r4 } from "./svc4";
import { run as r5 } from "./svc5";
import { run as r6 } from "./svc6";
import { run as r7 } from "./svc7";
import { run as r8 } from "./svc8";

const cases: ReadonlyArray<[() => string, string]> = [
  [r1, "gold:ping"],
  [r2, "silver:ping"],
  [r3, "bronze:ping"],
  [r4, "platinum:ping"],
  [r5, "diamond:ping"],
  [r6, "copper:ping"],
  [r7, "iron:ping"],
  [r8, "steel:ping"],
];

for (const [run, expected] of cases) {
  test(`migrated service returns ${expected}`, () => {
    expect(run()).toBe(expected);
  });
}
