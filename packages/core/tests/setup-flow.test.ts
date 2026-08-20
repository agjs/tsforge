import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSteps,
  configPreview,
  nonDefaultConventions,
  selectionsToConventions,
} from "../src/setup/wizard-flow";
import { driveWizard } from "../src/render/wizard";
import type { IWizardAction } from "../src/render/wizard.types";
import { runSetup } from "../src/setup/run-setup";
import { scanRepo } from "../src/infer-rules/scan";
import { resolveConventions } from "../src/infer-rules/conventions";

function repo(files: { path: string; content: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-setup-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix" }));

  for (const f of files) {
    const abs = join(dir, f.path);

    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content);
  }

  return dir;
}

describe("wizard flow mapping", () => {
  test("selectionsToConventions reads single answers; defaults fill gaps", () => {
    const state = {
      stepIndex: 0,
      cursor: 0,
      single: { interfaces: "bare-pascal-case", enums: "allow" },
      multi: {},
      text: {},
      status: "active" as const,
    };

    expect(selectionsToConventions(state)).toEqual(
      resolveConventions({ interfaces: "bare-pascal-case", enums: "allow" })
    );
  });

  test("nonDefaultConventions keeps only diffs from the house default", () => {
    expect(
      nonDefaultConventions(resolveConventions({ enums: "allow" }))
    ).toEqual({ enums: "allow" });

    expect(nonDefaultConventions(resolveConventions(undefined))).toEqual({});
  });

  test("configPreview shows the fragment, or a no-op note for all-defaults", () => {
    expect(configPreview(resolveConventions({ enums: "allow" }))).toContain(
      '"enums": "allow"'
    );
    expect(configPreview(resolveConventions(undefined))).toContain(
      "no conventions written"
    );
  });

  test("buildSteps drives end-to-end on a bare-PascalCase repo", async () => {
    const dir = repo([
      { path: "src/a.ts", content: "export interface User { id: string; }" },
      { path: "src/b.ts", content: "export interface Order { n: number; }" },
      { path: "src/c.ts", content: "export interface Invoice { n: number; }" },
    ]);

    try {
      const report = await scanRepo(dir);
      const steps = buildSteps(report);

      // Enough bare interfaces (>= the min-sample floor) to infer bare-pascal-case;
      // the interfaces step preselects that recommendation.
      const actions: IWizardAction[] = [
        ...steps.map((): IWizardAction => "confirm"),
        "confirm", // overview → apply
      ];
      const applied = driveWizard(steps, actions);

      expect(selectionsToConventions(applied).interfaces).toBe(
        "bare-pascal-case"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSetup orchestration", () => {
  test("non-TTY without --yes prints a proposal and writes nothing", async () => {
    const dir = repo([
      { path: "src/e.ts", content: "export enum Color { Red }" },
    ]);
    let out = "";

    try {
      const code = await runSetup({
        cwd: dir,
        yes: false,
        color: false,
        interactive: false,
        out: (s) => {
          out += s;
        },
      });

      expect(code).toBe(0);
      expect(out).toContain("non-interactive");
      expect(out).toContain("Re-run in a terminal");
      expect(existsSync(join(dir, "tsforge.config.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--yes writes the recommended conventions", async () => {
    const dir = repo([
      { path: "src/a.ts", content: "export interface User { id: string; }" },
      { path: "src/b.ts", content: "export interface Order { n: number; }" },
      { path: "src/c.ts", content: "export interface Invoice { n: number; }" },
      { path: "src/e.ts", content: "export enum Color { Red }" },
    ]);
    let out = "";

    try {
      const code = await runSetup({
        cwd: dir,
        yes: true,
        color: false,
        out: (s) => {
          out += s;
        },
      });

      expect(code).toBe(0);
      expect(out).toContain("Wrote tsforge.config.json");

      const written = JSON.parse(
        await Bun.file(join(dir, "tsforge.config.json")).text()
      );

      // Bare interfaces + enums present → bare-pascal-case + allow.
      expect(written.conventions.interfaces).toBe("bare-pascal-case");
      expect(written.conventions.enums).toBe("allow");
      expect(existsSync(join(dir, ".tsforge/setup-evidence.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
