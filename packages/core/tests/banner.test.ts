import { test, expect } from "bun:test";
import { welcomeBanner } from "../src/render";

const ESC = String.fromCharCode(27);

test("welcomeBanner: every framed line is the same visible width", () => {
  const banner = welcomeBanner({
    model: "qwen3.6-35b-a3b",
    endpoint: "localhost:8000",
    color: false,
  });

  const framed = banner
    .split("\n")
    .filter((l) => l.startsWith("╭") || l.startsWith("│") || l.startsWith("╰"));

  // Count code points (box-drawing chars are 1 each) — all rows must align.
  const widths = new Set(framed.map((l) => Array.from(l).length));

  expect(widths.size).toBe(1);
  expect(Array.from(widths)[0]).toBe(60); // │ + 58 inner + │
});

test("welcomeBanner: shows the brand, model, and endpoint", () => {
  const banner = welcomeBanner({
    model: "qwen3.6-35b-a3b",
    endpoint: "localhost:8000",
    color: false,
  });

  expect(banner).toContain("tsforge");
  expect(banner).toContain("strict TypeScript, gate-driven");
  expect(banner).toContain("qwen3.6-35b-a3b");
  expect(banner).toContain("localhost:8000");
  // color:false ⇒ plain text, no ANSI escape codes
  expect(banner.includes(ESC)).toBe(false);
});

test("welcomeBanner: emits ANSI codes when color is on", () => {
  expect(welcomeBanner({ model: "m", endpoint: "e", color: true })).toContain(
    ESC
  );
});
