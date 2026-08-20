import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  promotionVerdict,
  regressed,
  installOverlay,
  revertOverlay,
  previousPath,
  emptyOverlay,
  overlayPathFor,
} from "../src/self-harness";
import type { ISweepReport } from "../src/eval";

/**
 * The promotion gate is the only thing standing between an unattended loop and
 * the harness a human's own sessions run under. Its failure mode is silent: a
 * wrong verdict installs a worse harness and nobody is watching.
 */

const SAVED_HOME = process.env.TSFORGE_HOME;

function restoreHome(): void {
  if (SAVED_HOME === undefined) {
    delete process.env.TSFORGE_HOME;
  } else {
    process.env.TSFORGE_HOME = SAVED_HOME;
  }
}

/** A two-variant proof report. `ci` is the candidate's Wilson interval. */
function report(opts: {
  baselineRate: number;
  delta: number;
  significant: boolean;
  ci: [number, number];
}): ISweepReport {
  return {
    baseline: "baseline",
    variants: [
      {
        label: "baseline",
        passRate: opts.baselineRate,
        passRateCI: [0, 1],
      },
      {
        label: "self-harness",
        passRate: opts.baselineRate + opts.delta,
        passRateCI: opts.ci,
        vsBaseline: {
          deltaPassRate: opts.delta,
          z: opts.significant ? 2.4 : 0.8,
          significant: opts.significant,
        },
      },
    ],
  } as unknown as ISweepReport;
}

describe("promotionVerdict", () => {
  test("promotes a significant uplift that clears its own interval", () => {
    const v = promotionVerdict(
      report({
        baselineRate: 0.5,
        delta: 0.25,
        significant: true,
        ci: [0.6, 0.9],
      })
    );

    expect(v.promote).toBe(true);
    expect(v.reason).toContain("significant uplift");
  });

  test("refuses a positive but non-significant delta", () => {
    // The common case in a small proof split: real-looking movement that is
    // indistinguishable from noise. Installing on this is how a loop drifts.
    const v = promotionVerdict(
      report({
        baselineRate: 0.5,
        delta: 0.1,
        significant: false,
        ci: [0.45, 0.75],
      })
    );

    expect(v.promote).toBe(false);
    expect(v.reason).toContain("not significant");
  });

  test("refuses an uplift whose lower bound does not clear the baseline", () => {
    // Significant by the z-test, but the candidate's own interval still
    // contains the baseline's rate — the improvement does not survive its
    // error bars.
    const v = promotionVerdict(
      report({
        baselineRate: 0.5,
        delta: 0.08,
        significant: true,
        ci: [0.42, 0.74],
      })
    );

    expect(v.promote).toBe(false);
    expect(v.reason).toContain("does not survive its own interval");
  });

  test("refuses a regression outright", () => {
    const v = promotionVerdict(
      report({
        baselineRate: 0.6,
        delta: -0.2,
        significant: true,
        ci: [0.2, 0.6],
      })
    );

    expect(v.promote).toBe(false);
    expect(v.reason).toContain("no uplift");
  });

  test("refuses when the proof produced no comparison", () => {
    // A measurement that never ran must never read as approval.
    const empty = { baseline: "baseline", variants: [] } as ISweepReport;

    expect(promotionVerdict(empty).promote).toBe(false);
  });
});

describe("regressed", () => {
  test("fires on a significant negative delta", () => {
    const r = regressed(
      report({
        baselineRate: 0.7,
        delta: -0.3,
        significant: true,
        ci: [0.2, 0.6],
      })
    );

    expect(r.yes).toBe(true);
  });

  test("does not fire on noise", () => {
    expect(
      regressed(
        report({
          baselineRate: 0.7,
          delta: -0.05,
          significant: false,
          ci: [0.5, 0.8],
        })
      ).yes
    ).toBe(false);
  });

  test("is easier to trip than promotion — rollback needs no interval check", () => {
    // Asymmetric on purpose: an unattended loop should undo its own work more
    // readily than it trusts it. This delta is significant and negative but its
    // interval is wide; promotion would refuse the mirror case.
    const r = report({
      baselineRate: 0.7,
      delta: -0.15,
      significant: true,
      ci: [0.3, 0.8],
    });

    expect(regressed(r).yes).toBe(true);
    expect(promotionVerdict(r).promote).toBe(false);
  });
});

describe("install and rollback", () => {
  afterEach(restoreHome);

  async function home(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-promote-"));

    process.env.TSFORGE_HOME = dir;

    return dir;
  }

  test("install writes the overlay where the runtime looks for it", async () => {
    const dir = await home();

    try {
      const overlay = {
        ...emptyOverlay(),
        promptBlocks: { extra: { mode: "append" as const, text: "hello" } },
      };

      await installOverlay("deepseek/flash", overlay);

      const live = overlayPathFor("deepseek/flash");

      expect(existsSync(live)).toBe(true);
      expect(JSON.parse(await readFile(live, "utf8"))).toEqual(overlay);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("install keeps the displaced overlay as the rollback point", async () => {
    const dir = await home();

    try {
      const first = {
        ...emptyOverlay(),
        promptBlocks: { extra: { mode: "append" as const, text: "first" } },
      };

      await installOverlay("m", first);
      await installOverlay("m", emptyOverlay());

      expect(
        JSON.parse(await readFile(previousPath(overlayPathFor("m")), "utf8"))
      ).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollback restores the previous overlay", async () => {
    const dir = await home();

    try {
      const first = {
        ...emptyOverlay(),
        promptBlocks: { extra: { mode: "append" as const, text: "first" } },
      };

      await installOverlay("m", first);
      await installOverlay("m", emptyOverlay());

      expect(await revertOverlay("m")).toBe(true);
      expect(JSON.parse(await readFile(overlayPathFor("m"), "utf8"))).toEqual(
        first
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollback with nothing to restore removes the overlay entirely", async () => {
    // The base harness is always a safe resting state. A rollback must never
    // leave a known-bad overlay installed for want of a replacement.
    const dir = await home();

    try {
      await installOverlay("m", emptyOverlay());

      expect(await revertOverlay("m")).toBe(false);
      expect(existsSync(overlayPathFor("m"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no partial overlay is ever visible at the live path", async () => {
    // activeOverlay() reads this path synchronously on a hot path with no
    // locking, so the write has to be atomic. A session starting mid-install
    // must see either the old overlay or the new one.
    const dir = await home();

    try {
      const live = overlayPathFor("m");

      await mkdir(dirname(live), { recursive: true });
      await writeFile(live, JSON.stringify(emptyOverlay()));

      const big = {
        ...emptyOverlay(),
        promptBlocks: {
          extra: { mode: "append" as const, text: "x".repeat(200_000) },
        },
      };

      await installOverlay("m", big);

      // Whatever is there parses — never a truncated prefix.
      expect(JSON.parse(await readFile(live, "utf8"))).toEqual(big);
      expect(existsSync(`${live}.tmp`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent installs never interleave into a corrupt live overlay", async () => {
    // A campaign install racing a manual one (or a relaunch) both wrote the same
    // fixed `${live}.tmp`; the two writes interleaved and `rename` could publish
    // a half-merged document. A per-write unique temp name makes the winner one
    // whole overlay — never a byte-interleave of two.
    const dir = await home();

    try {
      const a = {
        ...emptyOverlay(),
        promptBlocks: {
          extra: { mode: "append" as const, text: "A".repeat(90_000) },
        },
      };
      const b = {
        ...emptyOverlay(),
        promptBlocks: {
          extra: { mode: "append" as const, text: "B".repeat(90_000) },
        },
      };

      await Promise.all([installOverlay("m", a), installOverlay("m", b)]);

      // The live file is exactly ONE of the two overlays, intact — not a splice.
      const live = overlayPathFor("m");
      const parsed = JSON.parse(await readFile(live, "utf8"));

      expect([a, b]).toContainEqual(parsed);
      expect(existsSync(`${live}.tmp`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
