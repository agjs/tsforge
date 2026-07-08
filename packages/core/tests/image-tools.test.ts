import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doReadImage,
  doGenerateImage,
  resolveImageCapabilityFlags,
  type IImageToolDeps,
} from "../src/loop/tools/image-tools";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { IModelEntry } from "../src/models-config";

const VISION_ENTRY: IModelEntry = { baseUrl: "https://v/v1", model: "vlm" };
const IMAGE_ENTRY: IModelEntry = {
  baseUrl: "https://i/v1",
  model: "gen",
  imageApi: "chat-modalities",
};

function ctx(cwd: string, over: Partial<IToolContext> = {}): IToolContext {
  return {
    cwd,
    files: [],
    task: "t",
    report: () => {
      /* swallow */
    },
    ...over,
  };
}

function deps(over: Partial<IImageToolDeps>): IImageToolDeps {
  return {
    resolveCap: async () => null,
    describe: async () => "described",
    generate: async () => [
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
    ],
    save: async (_images, dir, base) => [join(dir, `${base}.png`)],
    readImageFile: async () => ({ base64: "AAAA", mimeType: "image/png" }),
    ...over,
  };
}

test("read_image: reports 'not configured' when no vision capability", async () => {
  const out = await doReadImage(
    { file: "x.png" },
    ctx("/tmp"),
    deps({ resolveCap: async () => null })
  );

  expect(out).toContain("vision is not configured");
});

test("read_image: passes image + question to the vision backend", async () => {
  let seenPrompt = "";
  let seenImages = 0;

  const out = await doReadImage(
    { file: "shot.png", question: "what error is shown?" },
    ctx("/work"),
    deps({
      resolveCap: async () => ({ name: "vlm", entry: VISION_ENTRY }),
      describe: async (_cfg, input) => {
        seenPrompt = input.prompt;
        seenImages = input.images.length;

        return "a stack trace";
      },
    })
  );

  expect(out).toBe("a stack trace");
  expect(seenPrompt).toBe("what error is shown?");
  expect(seenImages).toBe(1);
});

test("read_image: rejects an out-of-scope path", async () => {
  const out = await doReadImage(
    { file: "../../etc/passwd.png" },
    ctx("/work"),
    deps({ resolveCap: async () => ({ name: "vlm", entry: VISION_ENTRY }) })
  );

  expect(out).toContain("out-of-scope");
});

test("read_image: rejects a symlink that escapes the workspace (real fs)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsforge-sym-"));
  const { mkdir } = await import("node:fs/promises");

  try {
    const work = join(root, "work");
    const secret = join(root, "secret");

    await mkdir(work, { recursive: true });
    await mkdir(secret, { recursive: true });
    await writeFile(join(secret, "secret.png"), Buffer.from([137, 80, 78, 71]));
    // a workspace symlink pointing OUT of the tree
    await symlink(join(secret, "secret.png"), join(work, "link.png"));

    const out = await doReadImage(
      { file: "link.png" },
      ctx(work),
      deps({
        resolveCap: async () => ({ name: "vlm", entry: VISION_ENTRY }),
        // load would succeed — the symlink escape must be rejected BEFORE that
        readImageFile: async () => ({ base64: "AAAA", mimeType: "image/png" }),
      })
    );

    expect(out).toContain("out-of-scope");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_image: rejects an unsupported/missing file", async () => {
  const out = await doReadImage(
    { file: "notes.txt" },
    ctx("/work"),
    deps({
      resolveCap: async () => ({ name: "vlm", entry: VISION_ENTRY }),
      readImageFile: async () => null,
    })
  );

  expect(out).toContain("cannot read image");
});

test("generate_image: saves under .tsforge/images and previews inline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-gentool-"));

  try {
    const previews: string[] = [];
    let genApi: string | undefined;

    const out = await doGenerateImage(
      { prompt: "a fox", size: "1024x1024" },
      ctx(dir, { previewImage: (img) => previews.push(img.path) }),
      deps({
        resolveCap: async () => ({ name: "gen", entry: IMAGE_ENTRY }),
        generate: async (_cfg, input) => {
          genApi = input.api;

          return [{ bytes: new Uint8Array([9]), mimeType: "image/png" }];
        },
        // real save so the path is under the temp cwd
        save: (await import("../src/inference/image-gen")).saveGeneratedImages,
      })
    );

    expect(out).toMatch(/Generated 1 image\(s\): \.tsforge\/images\/image-/);
    expect(genApi).toBe("chat-modalities");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain(join(dir, ".tsforge", "images"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generate_image: a model decline returns a clear reason, not a crash", async () => {
  const out = await doGenerateImage(
    { prompt: "homer simpson playing guitar" },
    ctx("/tmp"),
    deps({
      resolveCap: async () => ({ name: "gen", entry: IMAGE_ENTRY }),
      generate: async () => {
        throw new Error(
          "image model declined: I can't create copyrighted characters."
        );
      },
    })
  );

  // terse + factual: the real reason, no crash framing, no meta-instructions the
  // model would parrot back to the user
  expect(out).toContain("image not generated");
  expect(out).toContain("copyrighted characters");
  expect(out).not.toContain("FAILED");
  expect(out).not.toContain("backend");
});

test("generate_image: not-configured + empty-prompt rejections", async () => {
  const notConfigured = await doGenerateImage(
    { prompt: "x" },
    ctx("/tmp"),
    deps({ resolveCap: async () => null })
  );

  expect(notConfigured).toContain("image generation is not configured");

  const emptyPrompt = await doGenerateImage(
    { prompt: "" },
    ctx("/tmp"),
    deps({ resolveCap: async () => ({ name: "gen", entry: IMAGE_ENTRY }) })
  );

  expect(emptyPrompt).toContain("non-empty `prompt`");
});

test("resolveImageCapabilityFlags: treats a throwing resolver as unconfigured", async () => {
  const flags = await resolveImageCapabilityFlags(async (cap) => {
    if (cap === "vision") {
      return { name: "v", entry: VISION_ENTRY };
    }

    throw new Error("bad env");
  });

  expect(flags.vision).toBe(true);
  expect(flags.imageGen).toBe(false);
});
