import { test, expect, beforeEach } from "bun:test";
import {
  countPaint,
  countAppendMain,
  countSetAgentTree,
  countBytes,
  paintStats,
  resetPaintStats,
  formatPerfSummary,
} from "../src/render/frame/paint-stats";

beforeEach(() => {
  resetPaintStats();
});

test("counters accumulate per kind", () => {
  countPaint("full", 2.5);
  countPaint("full", 1.5);
  countPaint("mainOnly", 0.5);
  countPaint("inputOnly", 0.25);
  countPaint("topOnly", 0.1);
  countAppendMain();
  countAppendMain();
  countSetAgentTree();
  countBytes(100);
  countBytes(50);

  const s = paintStats();

  expect(s.fullPaints).toBe(2);
  expect(s.fullPaintMs).toBeCloseTo(4);
  expect(s.mainOnlyPaints).toBe(1);
  expect(s.inputOnlyPaints).toBe(1);
  expect(s.topOnlyPaints).toBe(1);
  expect(s.appendMainCalls).toBe(2);
  expect(s.setAgentTreeCalls).toBe(1);
  expect(s.bytesWritten).toBe(150);
});

test("resetPaintStats zeroes everything", () => {
  countPaint("full", 1);
  resetPaintStats();

  expect(paintStats().fullPaints).toBe(0);
  expect(paintStats().fullPaintMs).toBe(0);
});

test("summary line is machine-parseable JSON with a stable lead", () => {
  countPaint("mainOnly", 1);

  const line = formatPerfSummary();

  expect(line.startsWith("perf_summary ")).toBe(true);

  const parsed: unknown = JSON.parse(line.slice("perf_summary ".length));

  expect(parsed).toMatchObject({ mainOnlyPaints: 1 });
});
