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

  test("echoes the post-format content (numbered) when it diverged", () => {
    const written = "export const x = 'a'\n"; // single quotes, no semicolon
    const current = 'export const x = "a";\n'; // prettier-normalized
    const out = reformatEcho("a.ts", written, current);

    expect(out).toContain("auto-formatted");
    expect(out).toContain('export const x = "a";'); // the actual on-disk text
    expect(out.toLowerCase()).toContain("oldstring");
  });

  test("does not number a phantom trailing line for a newline-terminated file", () => {
    // Two real lines + standard trailing newline → exactly lines 1 and 2, no `3`.
    const out = reformatEcho("a.ts", "a\nb", "const a = 1;\nconst b = 2;\n");
    const lineNumbers = [...out.matchAll(/^(\d+)/gmu)].map((m) => m[1]);

    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(lineNumbers).toEqual(["1", "2"]); // no phantom "3" from the trailing \n
  });

  test("inlines content for files up to the 200-line cap", () => {
    const written = "x";
    const current = Array.from({ length: 150 }, (_, i) => `line${i}`).join(
      "\n"
    );
    const out = reformatEcho("mid.ts", written, current);

    expect(out).toContain("line5");
    expect(out).toContain("CURRENT content");
  });

  test("a large reshaped file gets a re-read note, not inlined content", () => {
    const written = "x";
    const current = Array.from({ length: 201 }, (_, i) => `line${i}`).join(
      "\n"
    );
    const out = reformatEcho("big.ts", written, current);

    expect(out).toContain("re-read");
    expect(out).not.toContain("line5"); // content NOT inlined (too large)
  });
});

describe("appendReformatEcho (dirty write-check still gets disk truth)", () => {
  test("concatenates echo onto write-check feedback when format diverged", () => {
    const feedback =
      "\n\n⚠ CHECK of this file found 1 issue(s) — fix them now (edit this file)";
    const written = "export const x = 'a'\n";
    const current = 'export const x = "a";\n';
    const out = appendReformatEcho(feedback, "a.ts", written, current);

    expect(out.startsWith(feedback)).toBe(true);
    expect(out).toContain('export const x = "a";');
    expect(out).toContain("oldString");
  });

  test("leaves feedback unchanged when format did not diverge", () => {
    const feedback = "\n\n⚠ BLAST RADIUS — 1 file broken";
    const code = "export const x = 1;\n";

    expect(appendReformatEcho(feedback, "a.ts", code, code)).toBe(feedback);
  });
});
