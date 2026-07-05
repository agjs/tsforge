import { test, expect } from "bun:test";
import { welcomeBanner } from "../src/render";

const ESC = String.fromCharCode(27);

/** Strip ANSI SGR codes so we can assert on the visible glyphs. */
function stripAnsi(s: string): string {
  const codes = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

  return s.replace(codes, "");
}

test("welcomeBanner: renders the ANSI-Shadow tsforge wordmark", () => {
  const banner = welcomeBanner({
    model: "qwen3.6-35b-a3b",
    endpoint: "localhost:8000",
    color: false,
  });

  // The figlet top row is present intact (the wordmark, not the literal word).
  expect(banner).toContain("████████╗███████╗███████╗");
});

test("welcomeBanner: shows the tagline, model, and endpoint", () => {
  const banner = welcomeBanner({
    model: "qwen3.6-35b-a3b",
    endpoint: "localhost:8000",
    color: false,
  });

  expect(banner).toContain("strict TypeScript · gate-driven");
  expect(banner).toContain("qwen3.6-35b-a3b");
  expect(banner).toContain("localhost:8000");
  // color:false ⇒ plain text, no ANSI escape codes
  expect(banner.includes(ESC)).toBe(false);
});

test("welcomeBanner: paints a cyan→violet gradient across the wordmark", () => {
  const banner = welcomeBanner({ model: "m", endpoint: "e", color: true });

  // Gradient starts cyan (34;211;238) and ends violet (168;85;247).
  expect(banner).toContain("38;2;34;211;238");
  expect(banner).toContain("38;2;168;85;247");
  // Stripping the color codes leaves the wordmark glyphs intact.
  expect(stripAnsi(banner)).toContain("███████╗");
});
