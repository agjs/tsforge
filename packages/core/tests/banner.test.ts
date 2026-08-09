import { test, expect } from "bun:test";
import { welcomeBanner } from "../src/render";
import { planHint } from "../src/cli/banner";

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

test("planHint: filled PLAN badge + orange rail strip", () => {
  const out = planHint(false, 40);
  const plain = stripAnsi(out);

  expect(out).toContain("[48;2;255;153;0m"); // planBg
  expect(plain).toContain(" PLAN ");
  expect(plain).toMatch(/^ PLAN /m);
  expect(plain).toContain("REPLY TO REFINE");
  expect(plain).toContain("[ APPROVE ]");
  expect(plain).toContain("TO CONTINUE");
  expect(plain).toContain("│  REPLY TO REFINE");
  expect(plain).not.toContain("◆");
  // Pad row between hairline and body.
  const rows = plain.split("\n");

  expect(rows[0]?.startsWith(" PLAN ")).toBe(true);
  expect(rows[1]?.trim()).toBe("│");
  expect(rows[2]).toContain("REPLY TO REFINE");
});

test("planHint: ready state nudges approve to build", () => {
  const plain = stripAnsi(planHint(true, 40));

  expect(plain).toContain(" PLAN ");
  expect(plain).toContain("[ APPROVE ]");
  expect(plain).toContain("TO BUILD");
});
