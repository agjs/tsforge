import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScoutContext } from "../src/loop/scout";
import { buildTsService } from "../src/loop/turn";
import type { IFileView } from "../src/lib/fs";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-scout-"));

  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.ts"]}'
  );
  writeFileSync(
    join(dir, "util.ts"),
    "export function area(w: number, h: number): number {\n  return w * h;\n}\n"
  );
  writeFileSync(
    join(dir, "caller.ts"),
    'import { area } from "./util";\nexport const room = area(3, 4);\n'
  );

  return dir;
}

test("scout names the callers of an editable file (the blast radius)", async () => {
  const dir = fixture();

  try {
    const svc = await buildTsService(dir);
    const editable: IFileView[] = [
      { path: "util.ts", content: "export function area(){}" },
    ];
    const out = buildScoutContext(svc, dir, editable);

    expect(out.toLowerCase()).toContain("blast radius");
    expect(out).toContain("area");
    expect(out).toContain("caller.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scout is empty for a not-yet-created (empty) editable file", async () => {
  const dir = fixture();

  try {
    const svc = await buildTsService(dir);
    const out = buildScoutContext(svc, dir, [{ path: "new.ts", content: "" }]);

    expect(out).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scout is empty with no LanguageService (no tsconfig)", () => {
  expect(
    buildScoutContext(null, "/tmp", [{ path: "a.ts", content: "x" }])
  ).toBe("");
});
