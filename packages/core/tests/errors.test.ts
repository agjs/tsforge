import { test, expect } from "bun:test";
import { diffErrorSets, shrank, sameErrorSet } from "../src/validate";

const e = (k: string) => ({ key: k, message: k });

test("diffErrorSets splits fixed / introduced / remaining", () => {
  const d = diffErrorSets([e("a"), e("b")], [e("b"), e("c")]);

  expect(d.fixed.map((x) => x.key)).toEqual(["a"]);
  expect(d.introduced.map((x) => x.key)).toEqual(["c"]);
  expect(d.remaining.map((x) => x.key)).toEqual(["b"]);
});

test("shrank is true only when the set got smaller", () => {
  expect(shrank([e("a"), e("b")], [e("a")])).toBe(true);
  expect(shrank([e("a")], [e("b")])).toBe(false); // same size, swapped = no progress
});

test("sameErrorSet: identical = stuck; ANY change = progress (incl. lateral)", () => {
  // truly stuck — the model changed nothing
  expect(sameErrorSet([e("a"), e("b")], [e("b"), e("a")])).toBe(true); // order-insensitive
  // lateral progress (fixed one, surfaced another) is NOT stuck — keep going
  expect(sameErrorSet([e("a"), e("b")], [e("a"), e("c")])).toBe(false);
  // shrank or grew = progress
  expect(sameErrorSet([e("a"), e("b")], [e("a")])).toBe(false);
  expect(sameErrorSet([e("a")], [e("a"), e("b")])).toBe(false);
});
