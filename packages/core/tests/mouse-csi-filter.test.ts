import { test, expect, describe } from "bun:test";
import {
  createMouseCsiFilter,
  stripMouseReports,
} from "../src/render/frame/ansi-plain";

const ESC = String.fromCharCode(27);

describe("createMouseCsiFilter", () => {
  test("complete wheel report is extracted and never reaches cleaned", () => {
    const f = createMouseCsiFilter();
    const report = `${ESC}[<65;96;52M`;
    const out = f.feed(report);

    expect(out.reports).toEqual([report]);
    expect(out.cleaned).toBe("");
    expect(out.holding).toBe(false);
  });

  test("ESC then orphan tail across chunks reassembles (no prompt garbage)", () => {
    const f = createMouseCsiFilter();
    const first = f.feed(ESC);

    expect(first.cleaned).toBe("");
    expect(first.holding).toBe(true);
    expect(first.reports).toEqual([]);

    const second = f.feed("[<65;96;52M");

    expect(second.reports).toEqual([`${ESC}[<65;96;52M`]);
    expect(second.cleaned).toBe("");
    expect(second.holding).toBe(false);
  });

  test("orphan tail alone (ESC already eaten) is stripped and reconstructed", () => {
    const f = createMouseCsiFilter();
    const out = f.feed("[<65;96;52M[<64;102;46M");

    expect(out.reports).toEqual([`${ESC}[<65;96;52M`, `${ESC}[<64;102;46M`]);
    expect(out.cleaned).toBe("");
  });

  test("split mid-report holds until final byte", () => {
    const f = createMouseCsiFilter();

    expect(f.feed(`${ESC}[<65;96;5`).holding).toBe(true);
    const done = f.feed("2M");

    expect(done.reports).toEqual([`${ESC}[<65;96;52M`]);
    expect(done.cleaned).toBe("");
  });

  test("arrow CSI split after ESC still reaches cleaned intact", () => {
    const f = createMouseCsiFilter();

    expect(f.feed(ESC).holding).toBe(true);
    const out = f.feed("[A");

    expect(out.reports).toEqual([]);
    expect(out.cleaned).toBe(`${ESC}[A`);
    expect(out.holding).toBe(false);
  });

  test("flush emits a held bare ESC so real Escape is not lost", () => {
    const f = createMouseCsiFilter();

    f.feed(ESC);
    const out = f.flush();

    expect(out.cleaned).toBe(ESC);
    expect(out.holding).toBe(false);
  });

  test("printable text passes through; mouse in the middle is cut out", () => {
    const f = createMouseCsiFilter();
    const out = f.feed(`hi${ESC}[<0;1;2Mthere`);

    expect(out.reports).toEqual([`${ESC}[<0;1;2M`]);
    expect(out.cleaned).toBe("hithere");
  });
});

describe("stripMouseReports", () => {
  test("strips orphan tails without ESC (defense in depth)", () => {
    expect(stripMouseReports("[<65;96;52M")).toBe("");
    expect(stripMouseReports(`x${ESC}[<0;1;2My`)).toBe("xy");
  });
});
