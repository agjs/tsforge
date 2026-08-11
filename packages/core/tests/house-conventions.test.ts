import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeConventionProviders,
  houseConventionProvider,
  pathToConventionTopics,
  missingConventionPullReject,
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
    expect(contract).toContain("THAT path only");
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

  test("tsx maps to anatomy + layout + state + jsx", () => {
    expect(
      pathToConventionTopics("src/features/x/Foo.tsx", houseTopics)
    ).toEqual(["component-anatomy", "file-layout", "state", "jsx"]);
  });

  test("form-ish tsx also requires forms", () => {
    expect(
      pathToConventionTopics("src/features/x/CreateForm.tsx", houseTopics)
    ).toContain("forms");
  });

  test("hooks file maps to state", () => {
    expect(
      pathToConventionTopics("src/features/x/Foo.hooks.ts", houseTopics)
    ).toEqual(["state"]);
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
  test("missingConventionPullReject names topics only", () => {
    const msg = missingConventionPullReject("src/Foo.tsx", {
      conventionsActive: true,
      touched: new Set(),
      pulledTopics: new Set(),
      availableTopics: houseConventionProvider.topics(),
    });

    expect(msg).toContain("Missing topics:");
    expect(msg).toContain("component-anatomy");
    expect(msg).not.toContain("FILE PURITY");
  });

  test("after pull + touch, re-edit is allowed", () => {
    const pulled = new Set([
      "component-anatomy",
      "file-layout",
      "state",
      "jsx",
    ]);

    expect(
      missingConventionPullReject("src/Foo.tsx", {
        conventionsActive: true,
        touched: new Set(),
        pulledTopics: pulled,
        availableTopics: houseConventionProvider.topics(),
      })
    ).toBeNull();

    expect(
      missingConventionPullReject("src/Foo.tsx", {
        conventionsActive: true,
        touched: new Set(["src/Foo.tsx"]),
        pulledTopics: new Set(),
        availableTopics: houseConventionProvider.topics(),
      })
    ).toBeNull();
  });

  test("package.json is exempt", () => {
    expect(
      missingConventionPullReject("package.json", {
        conventionsActive: true,
        touched: new Set(),
        pulledTopics: new Set(),
        availableTopics: houseConventionProvider.topics(),
      })
    ).toBeNull();
  });

  test("doCreate rejects until topics are pulled; succeeds after", async () => {
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

      expect(blocked).toContain("Missing topics:");
      expect(blocked).toContain("component-anatomy");
      expect(await Bun.file(join(dir, "src/Widget.tsx")).exists()).toBe(false);

      for (const t of pathToConventionTopics(
        "src/Widget.tsx",
        houseConventionProvider.topics()
      )) {
        doPullConventions({ topic: t }, ctx);
      }

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
