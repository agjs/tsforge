import { test, expect, describe } from "bun:test";
import {
  formatGateLines,
  gateRailBadge,
  gateSteerText,
} from "../src/loop/gate/panel";
import type { IGateRailView } from "../src/loop/session-gate-view";
import type { IErrorItem } from "../src/validate/validate.types";
import { stripSgr } from "../src/render/frame/ansi-plain";

function err(partial: Partial<IErrorItem> & { key: string }): IErrorItem {
  return {
    message: partial.message ?? partial.key,
    ...partial,
  };
}

describe("gateSteerText", () => {
  test("includes rule and file:line", () => {
    expect(
      gateSteerText(
        err({
          key: "k1",
          rule: "no-explicit-any",
          file: "src/a.ts",
          line: 12,
        })
      )
    ).toBe("fix no-explicit-any at src/a.ts:12");
  });

  test("falls back to key when rule absent", () => {
    expect(
      gateSteerText(err({ key: "TS2322", file: "src/b.ts", line: 3 }))
    ).toBe("fix TS2322 at src/b.ts:3");
  });
});

describe("gateRailBadge", () => {
  test("shows near-green checkpoint arrow", () => {
    const view: IGateRailView = {
      errors: [err({ key: "a" }), err({ key: "b" })],
      errorCount: 5,
      nearGreenCheckpoint: 2,
      gateConfigured: true,
    };

    expect(gateRailBadge(view)).toBe("5 → 2");
  });

  test("empty when gate not configured", () => {
    expect(
      gateRailBadge({
        errors: [],
        errorCount: 0,
        gateConfigured: false,
      })
    ).toBe("");
  });
});

describe("formatGateLines", () => {
  test("header body lists sorted rule rows", () => {
    const view: IGateRailView = {
      errors: [
        err({ key: "z", rule: "zebra-rule", file: "src/z.ts", line: 1 }),
        err({ key: "a", rule: "alpha-rule", file: "src/a.ts", line: 9 }),
      ],
      errorCount: 2,
      gateConfigured: true,
    };

    const lines = formatGateLines(view, { color: false, columns: 40 });
    const plain = lines.map((l) => stripSgr(l));

    expect(plain[0]).toContain("alpha-rule");
    expect(plain[0]).toContain("src/a.ts:9");
    expect(plain[1]).toContain("zebra-rule");
  });

  test("green empty state", () => {
    const lines = formatGateLines(
      {
        errors: [],
        errorCount: 0,
        gateConfigured: true,
      },
      { color: false }
    );

    expect(stripSgr(lines[0] ?? "")).toBe("no gate errors");
  });

  test("no gate configured hint", () => {
    const lines = formatGateLines(
      {
        errors: [],
        errorCount: 0,
        gateConfigured: false,
      },
      { color: false }
    );

    expect(stripSgr(lines[0] ?? "")).toBe("(no gate configured)");
  });

  test("selected row shows rule doc excerpt", () => {
    const view: IGateRailView = {
      errors: [
        err({
          key: "k",
          rule: "no-explicit-any",
          file: "src/x.ts",
          line: 1,
        }),
      ],
      errorCount: 1,
      gateConfigured: true,
    };

    const lines = formatGateLines(view, {
      color: false,
      columns: 60,
      showSelection: true,
      selectedIndex: 0,
    });
    const plain = lines.map((l) => stripSgr(l)).join("\n");

    expect(plain).toContain("▸");
    expect(plain).toContain("no-explicit-any");
    expect(plain).toContain("explicit");
  });
});
