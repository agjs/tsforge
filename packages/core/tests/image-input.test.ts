import { test, expect } from "bun:test";
import {
  extractImagePaths,
  resolveImageInput,
  type IResolveImageInputDeps,
} from "../src/cli/image-input";
import type { IOpenAICompatibleConfig } from "../src/inference";

const VISION: IOpenAICompatibleConfig = {
  baseUrl: "https://v/v1",
  model: "vlm",
};

function deps(over: Partial<IResolveImageInputDeps>): IResolveImageInputDeps {
  return {
    resolveVision: async () => VISION,
    load: async () => ({ base64: "AAAA", mimeType: "image/png" }),
    describe: async () => "a login screen",
    ...over,
  };
}

test("extractImagePaths: @-mention, bare drag path, and quoted path", () => {
  const r = extractImagePaths(
    "look at @shot.png and /Users/ag/Pictures/bug.jpg plus 'my file.webp'",
    "/work"
  );

  expect(r.paths).toEqual([
    "/work/shot.png",
    "/Users/ag/Pictures/bug.jpg",
    "/work/my file.webp",
  ]);
  // tokens are replaced by inline markers; surrounding prose is preserved
  expect(r.cleanedLine).toContain("[image: shot.png]");
  expect(r.cleanedLine).toContain("[image: bug.jpg]");
  expect(r.cleanedLine).toContain("[image: my file.webp]");
  expect(r.cleanedLine).toContain("look at");
});

test("extractImagePaths: backslash-escaped spaces in a dragged path", () => {
  const r = extractImagePaths("/Users/ag/My\\ Shots/a\\ b.png", "/work");

  expect(r.paths).toEqual(["/Users/ag/My Shots/a b.png"]);
});

test("extractImagePaths: leaves non-image @mentions and prose alone", () => {
  const r = extractImagePaths("read @src/index.ts and explain", "/work");

  expect(r.paths).toEqual([]);
  expect(r.cleanedLine).toBe("read @src/index.ts and explain");
});

test("resolveImageInput: describes each image and prepends a context block", async () => {
  const seen: string[] = [];
  const out = await resolveImageInput("what is @a.png", "/work", {
    deps: deps({
      describe: async (_cfg, input) => {
        seen.push(input.images[0]!.base64);

        return "a chart";
      },
    }),
  });

  expect(out.imageCount).toBe(1);
  expect(out.contextBlock).toContain('[Attached image "a.png":');
  expect(out.contextBlock).toContain("a chart");
  expect(seen).toHaveLength(1);
});

test("resolveImageInput: identical images are described ONCE (no duplicate cost)", async () => {
  let calls = 0;
  const out = await resolveImageInput("look at these", "/work", {
    // three paths, but the default load() returns the same bytes for each
    extraPaths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    deps: deps({
      describe: async () => {
        calls += 1;

        return "a Homer Simpson image";
      },
    }),
  });

  expect(calls).toBe(1); // one vision call, not three
  expect(out.imageCount).toBe(1); // one unique image billed
  expect(out.contextBlock).toContain("a Homer Simpson image");
  expect(out.contextBlock).toContain("same as above"); // dupes reference the first
});

test("resolveImageInput: image-only send uses the default vision prompt (not the marker)", async () => {
  let seenPrompt = "";

  // an @-mention with no other text → cleanedLine is just "[image: a.png]"
  await resolveImageInput("@a.png", "/work", {
    deps: deps({
      describe: async (_cfg, input) => {
        seenPrompt = input.prompt;

        return "desc";
      },
    }),
  });

  expect(seenPrompt).not.toContain("[image:");
  expect(seenPrompt).toContain("software engineer"); // DEFAULT_VISION_PROMPT

  // clipboard chip only → also falls back to the default
  let chipPrompt = "";

  await resolveImageInput("[image #1]", "/work", {
    extraPaths: ["/tmp/clip.png"],
    deps: deps({
      describe: async (_cfg, input) => {
        chipPrompt = input.prompt;

        return "desc";
      },
    }),
  });

  expect(chipPrompt).toContain("software engineer");

  // but a REAL question alongside the image is used verbatim
  let qPrompt = "";

  await resolveImageInput("what error is @shot.png showing?", "/work", {
    deps: deps({
      describe: async (_cfg, input) => {
        qPrompt = input.prompt;

        return "desc";
      },
    }),
  });

  expect(qPrompt).toContain("what error");
  expect(qPrompt).not.toContain("[image:");
});

test("resolveImageInput: includes extraPaths (e.g. clipboard temp files)", async () => {
  const out = await resolveImageInput("here", "/work", {
    extraPaths: ["/tmp/clip.png"],
    deps: deps({}),
  });

  expect(out.imageCount).toBe(1);
  expect(out.contextBlock).toContain('[Attached image "clip.png"');
});

test("resolveImageInput: note (not a crash) when vision is unconfigured", async () => {
  const out = await resolveImageInput("see @a.png", "/work", {
    deps: deps({ resolveVision: async () => null }),
  });

  expect(out.imageCount).toBe(1);
  expect(out.contextBlock).toContain("no vision backend is configured");
});

test("resolveImageInput: no images → empty context, unchanged line", async () => {
  const out = await resolveImageInput("just text", "/work", { deps: deps({}) });

  expect(out.imageCount).toBe(0);
  expect(out.contextBlock).toBe("");
  expect(out.cleanedLine).toBe("just text");
});

test("resolveImageInput: a vision error degrades to a per-image note", async () => {
  const out = await resolveImageInput("@a.png", "/work", {
    deps: deps({
      describe: async () => {
        throw new Error("429 rate limited");
      },
    }),
  });

  expect(out.contextBlock).toContain("vision failed — 429 rate limited");
});
