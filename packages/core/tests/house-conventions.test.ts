import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeConventionProviders,
  houseConventionProvider,
  pathToConventionTopics,
  missingConventionTopics,
  conventionPullGate,
  isConventionExemptPath,
} from "../src/loop/conventions";
import { boringstackConventionProvider } from "../src/loop/boringstack/conventions";
import { doPullConventions } from "../src/loop/tools/pull-conventions";
import { doCreate } from "../src/loop/tools/file-ops";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { Session } from "../src/loop";
import type { IProvider, IChatMessage } from "../src/inference";
import { TOOL_NAME } from "../src/agent";
import { toolsFor } from "../src/loop/turn";

describe("house + boringstack compose", () => {
  test("house topics are a subset; BS adds stack-only topics", () => {
    const house = new Set(houseConventionProvider.topics());
    const bs = new Set(boringstackConventionProvider.topics());

    for (const t of house) {
      expect(bs.has(t)).toBe(true);
    }

    expect(bs.has("data-fetching")).toBe(true);
    expect(house.has("data-fetching")).toBe(false);
    expect(bs.has("i18n")).toBe(true);
    expect(house.has("i18n")).toBe(false);
  });

  test("compose lets extras override house guide wording", () => {
    const composed = composeConventionProviders(
      houseConventionProvider,
      boringstackConventionProvider
    );

    // BoringStack anatomy (features/, stories) wins over house (views|features).
    expect(composed.guide("component-anatomy")).toContain("src/features/");
    expect(composed.guide("component-anatomy")).toContain(".stories.tsx");
    expect(composed.guide("data-fetching")).toContain("@/lib/api/client");
  });

  test("buildGuides is the short pull contract, never a full-body wall", () => {
    const contract = houseConventionProvider.buildGuides();

    expect(contract).toContain("pull-before-first-write");
    expect(contract).toContain("component-anatomy");
    // The path→topic map is finally SHOWN to the model (it used to be referenced
    // but never rendered), while guide bodies stay out of the prompt.
    expect(contract).toContain("Path→topics:");
    expect(contract).toContain("*.tsx →");
    expect(contract).toContain("do NOT pull every topic");
    expect(contract).not.toContain("FILE PURITY");
    expect(boringstackConventionProvider.buildGuides()).not.toContain(
      "@/lib/api/client"
    );
  });

  test("house lint-gotchas / testing teach I-prefix, clock, and jsdom", () => {
    const lint = houseConventionProvider.guide("lint-gotchas") ?? "";
    const testing = houseConventionProvider.guide("testing") ?? "";

    expect(lint).toContain("I` prefix");
    expect(lint).toContain("time.ts");
    expect(lint).toContain("no-bare-date-now");
    expect(testing).toContain("@types/jsdom");
    expect(testing).toContain("time.test.ts");
    expect(testing).toContain("no-vacuous-expect");
    expect(testing).toContain("typeof");
  });

  test("naming-convention and no-bare-date-now PUSH lint-gotchas (house + BS)", () => {
    for (const provider of [
      houseConventionProvider,
      boringstackConventionProvider,
    ]) {
      const seen = new Set<string>();
      const pushed = provider.unseenForErrors(
        [{ rule: "@typescript-eslint/naming-convention" }],
        seen
      );

      expect(pushed.length).toBe(1);
      expect(pushed[0]).toContain("naming-convention");

      const seen2 = new Set<string>();
      const clock = provider.unseenForErrors(
        [{ rule: "tsforge/no-bare-date-now" }],
        seen2
      );

      expect(clock.length).toBe(1);
      expect(clock[0]).toContain("time.ts");
    }
  });
});

describe("pathToConventionTopics + exempt", () => {
  const houseTopics = houseConventionProvider.topics();

  test("tsx maps to anatomy + layout + state + jsx + no-casts", () => {
    expect(
      pathToConventionTopics("src/features/x/Foo.tsx", houseTopics)
    ).toEqual(["component-anatomy", "file-layout", "state", "jsx", "no-casts"]);
  });

  test("form-ish tsx also requires forms", () => {
    expect(
      pathToConventionTopics("src/features/x/CreateForm.tsx", houseTopics)
    ).toContain("forms");
  });

  test("hooks file maps to state + no-casts + lint-gotchas", () => {
    expect(
      pathToConventionTopics("src/features/x/Foo.hooks.ts", houseTopics)
    ).toEqual(["state", "no-casts", "lint-gotchas"]);
  });

  test("test file maps to testing", () => {
    expect(
      pathToConventionTopics("src/features/x/Foo.test.tsx", houseTopics)
    ).toContain("testing");
  });

  test("exempt bootstrap paths", () => {
    expect(isConventionExemptPath("package.json")).toBe(true);
    expect(isConventionExemptPath("vite.config.ts")).toBe(true);
    expect(isConventionExemptPath("tsconfig.json")).toBe(true);
    expect(isConventionExemptPath("index.html")).toBe(true);
    expect(isConventionExemptPath("src/app.css")).toBe(true);
    expect(isConventionExemptPath("public/favicon.ico")).toBe(true);
    expect(isConventionExemptPath(".env.local")).toBe(true);
    expect(isConventionExemptPath("src/Foo.tsx")).toBe(false);
  });
});

describe("pull-before-first-write enforcement", () => {
  test("conventionPullGate rejects ONCE with the guides embedded and marks them pulled", () => {
    const ctx = {
      conventions: houseConventionProvider,
      touched: new Set<string>(),
      pulledTopics: new Set<string>(),
    };
    const msg = conventionPullGate("src/Foo.tsx", ctx);

    expect(msg).toContain("requires conventions you have not read");
    expect(msg).toContain("component-anatomy");
    // The guides ride the reject, so the retry needs no pull round-trips…
    expect(msg).toContain("=== CONVENTION: component-anatomy ===");
    expect(msg).toContain("=== CONVENTION: no-casts ===");
    // …and the topics count as pulled.
    expect(ctx.pulledTopics.has("component-anatomy")).toBe(true);
    expect(ctx.pulledTopics.has("no-casts")).toBe(true);
    expect(conventionPullGate("src/Foo.tsx", ctx)).toBeNull();
  });

  test("after pull + touch, re-edit is allowed", () => {
    expect(
      missingConventionTopics("src/Foo.tsx", {
        conventionsActive: true,
        touched: new Set(),
        pulledTopics: new Set([
          "component-anatomy",
          "file-layout",
          "state",
          "jsx",
          "no-casts",
        ]),
        availableTopics: houseConventionProvider.topics(),
      })
    ).toEqual([]);

    expect(
      missingConventionTopics("src/Foo.tsx", {
        conventionsActive: true,
        touched: new Set(["src/Foo.tsx"]),
        pulledTopics: new Set(),
        availableTopics: houseConventionProvider.topics(),
      })
    ).toEqual([]);
  });

  test("package.json is exempt", () => {
    expect(
      missingConventionTopics("package.json", {
        conventionsActive: true,
        touched: new Set(),
        pulledTopics: new Set(),
        availableTopics: houseConventionProvider.topics(),
      })
    ).toEqual([]);
  });

  test("doCreate rejects once WITH guides; the immediate retry succeeds with zero pull calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-write-"));
    const pulledTopics = new Set<string>();
    const touched = new Set<string>();

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "t",
      conventions: houseConventionProvider,
      pulledTopics,
      touched,
    };

    try {
      const blocked = await doCreate(
        {
          file: "src/Widget.tsx",
          content: "export function Widget() { return null; }\n",
        },
        ctx
      );

      expect(blocked).toContain("requires conventions you have not read");
      expect(blocked).toContain("=== CONVENTION: component-anatomy ===");
      expect(await Bun.file(join(dir, "src/Widget.tsx")).exists()).toBe(false);

      // No pull_conventions round-trips: the reject embedded the guides and
      // marked them pulled, so the immediate retry lands.
      const ok = await doCreate(
        {
          file: "src/Widget.tsx",
          content: "export function Widget() { return null; }\n",
        },
        ctx
      );

      expect(ok).toContain("created");
      expect(await Bun.file(join(dir, "src/Widget.tsx")).exists()).toBe(true);

      // Simulate recordTouched (loop does this post-write).
      touched.add("src/Widget.tsx");

      const again = await doCreate(
        {
          file: "src/Widget.tsx",
          content: "export function Widget() { return null; }\n",
        },
        ctx
      );

      // Exists + parses ⇒ create:exists, not conventions (first-write already done).
      expect(again).toContain("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doPullConventions records pulledTopics", () => {
    const pulledTopics = new Set<string>();
    const ctx = {
      conventions: houseConventionProvider,
      pulledTopics,
    };

    doPullConventions({ topic: "no-casts" }, ctx);
    expect(pulledTopics.has("no-casts")).toBe(true);
  });
});

describe("Session offers house on gated drive-to-green", () => {
  function capturingProvider(cap: {
    system: string;
    toolNames?: string[];
  }): IProvider {
    return {
      async complete(messages: IChatMessage[]) {
        const sys = messages.find((m) => m.role === "system");

        cap.system = typeof sys?.content === "string" ? sys.content : "";

        return { content: "done", toolCalls: [] };
      },
    };
  }

  test("gated session advertises pull_conventions without an injected provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-house-offer-"));

    try {
      const cap = { system: "" };
      const session = await Session.create({
        provider: capturingProvider(cap),
        cwd: dir,
        files: ["**/*"],
        executionMode: "drive-to-green",
      });

      await session.send("go");

      expect(cap.system).toContain("pull-before-first-write");
      expect(cap.system).toContain("`pull_conventions`");

      const offered = toolsFor(
        false,
        {},
        true,
        false,
        false,
        houseConventionProvider.topics(),
        false
      );

      expect(
        offered.some((t) => t.function.name === TOOL_NAME.pullConventions)
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
