import { test, expect, describe } from "bun:test";
import { reformatEcho } from "../src/loop/write-guard";

describe("reformatEcho (preventive ACI echo on a clean write)", () => {
  test("no echo when the auto-format changed nothing", () => {
    const code = "export const x = 1;\n";

    expect(reformatEcho("a.ts", code, code)).toBe("");
  });

  test("no echo when the file is unreadable (current empty)", () => {
    expect(reformatEcho("a.ts", "whatever", "")).toBe("");
  });

  test("echoes the post-format content (numbered) when it diverged", () => {
    const written = "export const x = 'a'\n"; // single quotes, no semicolon
    const current = 'export const x = "a";\n'; // prettier-normalized
    const out = reformatEcho("a.ts", written, current);

    expect(out).toContain("auto-formatted");
    expect(out).toContain("1"); // numbered
    expect(out).toContain('export const x = "a";'); // the actual on-disk text
    // Tells the model to anchor on THIS, not what it wrote.
    expect(out.toLowerCase()).toContain("oldstring");
  });

  test("a large reshaped file gets a re-read note, not inlined content", () => {
    const written = "x";
    const current = Array.from({ length: 200 }, (_, i) => `line${i}`).join(
      "\n"
    );
    const out = reformatEcho("big.ts", written, current);

    expect(out).toContain("re-read");
    expect(out).not.toContain("line5"); // content NOT inlined (too large)
  });
});
