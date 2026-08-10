import { test, expect, describe } from "bun:test";
import { appendReformatEcho, reformatEcho } from "../src/loop/write-guard";

describe("reformatEcho (preventive ACI echo after format)", () => {
  test("no echo when the auto-format changed nothing", () => {
    const code = "export const x = 1;\n";

    expect(reformatEcho("a.ts", code, code)).toBe("");
  });

  test("no echo when the file is unreadable (current empty)", () => {
    expect(reformatEcho("a.ts", "whatever", "")).toBe("");
  });

  test("short re-read note when format diverged — no CURRENT dump", () => {
    const written = "export const x = 'a'\n"; // single quotes, no semicolon
    const current = 'export const x = "a";\n'; // prettier-normalized
    const out = reformatEcho("a.ts", written, current);

    expect(out).toContain("auto-formatted");
    expect(out).toContain("re-read");
    expect(out).not.toContain('export const x = "a";');
    expect(out).not.toContain("CURRENT content");
  });

  test("large reshaped files also get the short note", () => {
    const written = "x";
    const current = Array.from({ length: 201 }, (_, i) => `line${i}`).join(
      "\n"
    );
    const out = reformatEcho("big.ts", written, current);

    expect(out).toContain("re-read");
    expect(out).not.toContain("line5");
  });
});

describe("appendReformatEcho (dirty write-check still gets format hint)", () => {
  test("concatenates short echo onto write-check feedback when format diverged", () => {
    const feedback =
      "\n\n⚠ CHECK of this file found 1 issue(s) — fix them now (edit this file)";
    const written = "export const x = 'a'\n";
    const current = 'export const x = "a";\n';
    const out = appendReformatEcho(feedback, "a.ts", written, current);

    expect(out.startsWith(feedback)).toBe(true);
    expect(out).toContain("auto-formatted");
    expect(out).not.toContain('export const x = "a";');
  });

  test("leaves feedback unchanged when format did not diverge", () => {
    const feedback = "\n\n⚠ BLAST RADIUS — 1 file broken";
    const code = "export const x = 1;\n";

    expect(appendReformatEcho(feedback, "a.ts", code, code)).toBe(feedback);
  });
});
