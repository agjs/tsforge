import { expect, test } from "bun:test";
import { debounce } from "./debounce";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("collapses a burst into one call with the latest args", async () => {
  let calls = 0;
  let last = "";
  const fn = debounce((s: string) => {
    calls += 1;
    last = s;
  }, 30);

  fn("a");
  fn("b");
  fn("c");
  expect(calls).toBe(0);

  await sleep(70);
  expect(calls).toBe(1);
  expect(last).toBe("c");
});

test("a later burst fires again", async () => {
  let calls = 0;
  const fn = debounce(() => {
    calls += 1;
  }, 20);

  fn();
  await sleep(50);
  fn();
  await sleep(50);
  expect(calls).toBe(2);
});
