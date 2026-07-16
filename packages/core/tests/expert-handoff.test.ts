import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFixPrompt,
  extractCode,
  runExpertHandoff,
  resolveStuckFile,
  resolveExpertAsk,
  type IExpertRequest,
  type ExpertAsk,
} from "../src/loop/expert-handoff";

const REQ: IExpertRequest = {
  file: "src/views/Foo/index.tsx",
  content: "export const Foo = () => <div/>;\n",
  error: "L3: No `as` type casts (no-restricted-syntax)",
  goal: "build the Foo view",
};

describe("buildFixPrompt", () => {
  test("names the file, the exact error, the goal, and the current content", () => {
    const p = buildFixPrompt(REQ);

    expect(p).toContain("src/views/Foo/index.tsx");
    expect(p).toContain("No `as` type casts");
    expect(p).toContain("build the Foo view");
    expect(p).toContain("export const Foo");
    expect(p).toContain("ONLY the corrected FULL contents");
  });
});

describe("extractCode", () => {
  test("pulls the body out of a ```tsx fence", () => {
    const code = extractCode(
      "Here you go:\n```tsx\nexport const X = 1;\n```\nDone."
    );

    expect(code).toBe("export const X = 1;");
  });

  test("accepts a raw code reply with no fence", () => {
    expect(extractCode("export const Y = 2;\n")).toBe("export const Y = 2;");
  });

  test("returns null for a chatty non-code reply (never written to disk)", () => {
    expect(extractCode("Sorry, I can't help with that.")).toBeNull();
  });

  test("returns null for an empty fence", () => {
    expect(extractCode("```tsx\n\n```")).toBeNull();
  });
});

describe("runExpertHandoff", () => {
  test("applies a usable fix by overwriting the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-"));

    try {
      await Bun.write(join(dir, "a.ts"), "export const bad = 1 as any;\n");
      const ask: ExpertAsk = async () => "```ts\nexport const good = 1;\n```";

      const out = await runExpertHandoff(
        dir,
        { file: "a.ts", content: "x", error: "e", goal: "g" },
        ask
      );

      expect(out.applied).toBe(true);
      expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
        "export const good = 1;\n"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does NOT touch the file when the expert declines (no usable code)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-"));

    try {
      await Bun.write(join(dir, "a.ts"), "original\n");
      const ask: ExpertAsk = async () => "I cannot fix this.";

      const out = await runExpertHandoff(
        dir,
        { file: "a.ts", content: "x", error: "e", goal: "g" },
        ask
      );

      expect(out.applied).toBe(false);
      expect(await Bun.file(join(dir, "a.ts")).text()).toBe("original\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a throwing ask degrades to not-applied (never crashes the run)", async () => {
    const ask: ExpertAsk = async () => {
      throw new Error("network down");
    };

    const out = await runExpertHandoff(
      "/nonexistent",
      { file: "a.ts", content: "x", error: "e", goal: "g" },
      ask
    );

    expect(out.applied).toBe(false);
  });
});

describe("resolveExpertAsk gating (no surprise live/paid API call in tests or evals)", () => {
  test("returns null when the expert-rescue flag is OFF — even if a capability is configured", async () => {
    // The exact leak this guards: a stalled run in a unit test / eval sweep would call
    // the real configured expert model. Opt-in only — OFF by default, so it can't.
    const prev = process.env.TSFORGE_EXPERT_RESCUE;

    delete process.env.TSFORGE_EXPERT_RESCUE;

    try {
      expect(await resolveExpertAsk()).toBeNull();
    } finally {
      if (prev !== undefined) {
        process.env.TSFORGE_EXPERT_RESCUE = prev;
      }
    }
  });
});

describe("resolveStuckFile (the v5 fix — expert can target file-less errors)", () => {
  test("prefers a populated .file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "a.ts"), "x");

      expect(
        await resolveStuckFile(dir, [{ file: "a.ts", message: "boom" }])
      ).toBe("a.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses the file from the MESSAGE + adds the dropped src/ prefix (type-aware-lint)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "src/views/Issues/index.tsx"), "x");
      // The exact v5 shape: no `.file`, but the message names "views/Issues/..."
      // WITHOUT the src/ prefix. resolveStuckFile must still find it.
      const f = await resolveStuckFile(dir, [
        {
          message: "views/Issues/index.tsx:215 tsforge/no-inline-jsx-functions",
        },
      ]);

      expect(f).toBe("src/views/Issues/index.tsx");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finds a basename-only file under src/ (stub-check names 'dashboard.tsx', lives in src/routes/)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "src/routes/dashboard.tsx"), "x");
      const f = await resolveStuckFile(dir, [
        {
          message:
            "stub-check: 1 route(s) are still empty scaffold STUBS — Unfilled: dashboard.tsx",
        },
      ]);

      expect(f).toBe("src/routes/dashboard.tsx");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("null when no field/message resolves to an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      expect(
        await resolveStuckFile(dir, [{ message: "some prose, no path" }])
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStuckFile scope-safety (expert must not target locked files)", () => {
  test("prefers an in-scope resolved file over an out-of-scope one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "locked.ts"), "x\n");
      await Bun.write(join(dir, "src/app.ts"), "y\n");

      // Error names the locked file FIRST, then the editable one; scope wins.
      const f = await resolveStuckFile(
        dir,
        [
          { file: "locked.ts", message: "boom" },
          { file: "src/app.ts", message: "boom2" },
        ],
        ["src/**"]
      );

      expect(f).toBe("src/app.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when only out-of-scope files resolve and no fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "locked.ts"), "x\n");

      const f = await resolveStuckFile(
        dir,
        [{ file: "locked.ts", message: "boom" }],
        ["src/**"]
      );

      expect(f).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the in-scope rescue target when only out-of-scope files resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-"));

    try {
      await Bun.write(join(dir, "locked.ts"), "x\n");
      await Bun.write(join(dir, "src/service.ts"), "y\n");

      const f = await resolveStuckFile(
        dir,
        [{ file: "locked.ts", message: "boom" }],
        ["src/**"],
        "src/service.ts"
      );

      expect(f).toBe("src/service.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runExpertHandoff scope guard", () => {
  test("refuses to write a target outside the editable scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-"));

    try {
      await Bun.write(join(dir, "locked.ts"), "original\n");
      const ask: ExpertAsk = async () => "```ts\nexport const good = 1;\n```";

      const out = await runExpertHandoff(
        dir,
        { file: "locked.ts", content: "x", error: "e", goal: "g" },
        ask,
        ["src/**"]
      );

      expect(out.applied).toBe(false);
      // The locked file is untouched.
      expect(await Bun.file(join(dir, "locked.ts")).text()).toBe("original\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
