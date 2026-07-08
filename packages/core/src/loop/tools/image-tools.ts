import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  resolveCapabilityModel,
  resolveApiKey,
  type IModelEntry,
} from "../../models-config";
import type { IOpenAICompatibleConfig } from "../../inference";
import {
  describeImage,
  DEFAULT_VISION_PROMPT,
  type IImageInput,
} from "../../inference/vision";
import {
  generateImage,
  saveGeneratedImages,
  type IGeneratedImage,
} from "../../inference/image-gen";
import { str, reject, type IToolContext } from "./tool-context";

/**
 * The `read_image` (vision) and `generate_image` tool handlers. Both are thin:
 * resolve the configured capability backend, call the shared inference function
 * (`describeImage` / `generateImage`), and format a text result. Config
 * resolution is lazy (per call) so no capability plumbing threads through the
 * loop, and the whole surface is injectable for tests.
 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Cap on the vision model's returned text fed back into the conversation. */
const MAX_DESCRIPTION_CHARS = 8_000;

/** Largest image we'll read/base64-encode (bytes). Bounds memory, and anything
 *  bigger is rejected by the vision backends anyway. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Where generated images are written (under the workspace, git-ignorable). */
export const IMAGE_OUTPUT_DIR = join(".tsforge", "images");

export interface IImageToolDeps {
  resolveCap: typeof resolveCapabilityModel;
  describe: typeof describeImage;
  generate: typeof generateImage;
  save: typeof saveGeneratedImages;
  /** Read an image file → base64 + mime, or null if unreadable/oversized. */
  readImageFile: (
    absPath: string
  ) => Promise<{ base64: string; mimeType: string } | null>;
}

/** Is this path one of the image types the vision backend accepts? */
export function isSupportedImagePath(path: string): boolean {
  return IMAGE_MIME[extname(path).toLowerCase()] !== undefined;
}

/** Read an image file → `{ base64, mimeType }`, or null when it's missing or an
 *  unsupported type. Shared by the `read_image` tool and the REPL attachment flow. */
export async function loadImageFile(
  absPath: string
): Promise<IImageInput | null> {
  const mimeType = IMAGE_MIME[extname(absPath).toLowerCase()];

  if (mimeType === undefined) {
    return null;
  }

  const file = Bun.file(absPath);

  if (
    !(await file.exists()) ||
    file.size === 0 ||
    file.size > MAX_IMAGE_BYTES
  ) {
    return null;
  }

  return {
    base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    mimeType,
  };
}

/** The resolved vision backend wire-config, or null when vision isn't configured.
 *  Shared entry point for both the tool and the REPL drag/paste/@ attachment flow. */
export async function resolveVisionConfig(
  resolveCap: typeof resolveCapabilityModel = resolveCapabilityModel
): Promise<IOpenAICompatibleConfig | null> {
  const cap = await resolveCap("vision");

  return cap === null ? null : entryConfig(cap.entry);
}

const DEFAULT_DEPS: IImageToolDeps = {
  resolveCap: resolveCapabilityModel,
  describe: describeImage,
  generate: generateImage,
  save: saveGeneratedImages,
  readImageFile: loadImageFile,
};

/** Which image capabilities are configured — for tool advertisement (see
 *  toolsFor). A misconfigured env (e.g. base url without model) resolves to
 *  `false` rather than throwing, so a bad capability config can't crash a run;
 *  the tool then simply isn't offered. */
export async function resolveImageCapabilityFlags(
  resolveCap: typeof resolveCapabilityModel = resolveCapabilityModel
): Promise<{ vision: boolean; imageGen: boolean }> {
  const configured = async (cap: "vision" | "imageGen"): Promise<boolean> => {
    try {
      return (await resolveCap(cap)) !== null;
    } catch {
      return false;
    }
  };

  return {
    vision: await configured("vision"),
    imageGen: await configured("imageGen"),
  };
}

/** Build the wire config for a capability entry (key resolved at use time). Small
 *  local builder so this loop-layer module needn't import the cli `providerConfig`. */
function entryConfig(entry: IModelEntry): IOpenAICompatibleConfig {
  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    ...(entry.extraHeaders === undefined
      ? {}
      : { extraHeaders: entry.extraHeaders }),
    ...(entry.extraBody === undefined ? {} : { extraBody: entry.extraBody }),
  };
}

/** Resolve `file` under `cwd`, rejecting a path that escapes the workspace. */
function resolveInCwd(cwd: string, file: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(cwd, abs);

  return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

/** Re-check containment AFTER resolving symlinks — a lexical check passes a
 *  workspace symlink that points OUT of the tree, which the model could use to
 *  exfiltrate an arbitrary file to the vision backend. A missing target resolves
 *  to `true` here (the read then fails cleanly with "cannot read image"). */
async function realpathWithinCwd(cwd: string, abs: string): Promise<boolean> {
  const [realAbs, realCwd] = await Promise.all([
    realpath(abs).catch(() => null),
    realpath(cwd).catch(() => cwd),
  ]);

  if (realAbs === null) {
    return true;
  }

  const rel = relative(realCwd, realAbs);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function doReadImage(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IImageToolDeps = DEFAULT_DEPS
): Promise<string> {
  const cap = await deps.resolveCap("vision");

  if (cap === null) {
    return reject(
      ctx,
      "read_image",
      "vision is not configured — set a `vision` capability in ~/.tsforge/models.json " +
        "(or TSFORGE_VISION_BASE_URL/TSFORGE_VISION_MODEL) to enable image reading."
    );
  }

  const file = str(args, "file");
  const abs = file.length === 0 ? null : resolveInCwd(ctx.cwd, file);

  if (abs === null || !(await realpathWithinCwd(ctx.cwd, abs))) {
    return reject(
      ctx,
      "read_image",
      `invalid or out-of-scope image path: ${file}`
    );
  }

  const image = await deps.readImageFile(abs);

  if (image === null) {
    return reject(
      ctx,
      "read_image",
      `cannot read image "${file}" — it must exist, be a supported type (png/jpeg/webp/gif), and be ≤ 20 MB`
    );
  }

  const question = str(args, "question");
  const prompt = question.length > 0 ? question : DEFAULT_VISION_PROMPT;

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ read_image ${file} → ${cap.name}`,
  });

  const images: IImageInput[] = [image];
  const text = await deps.describe(
    entryConfig(cap.entry),
    { prompt, images },
    { signal: ctx.signal }
  );

  return text.slice(0, MAX_DESCRIPTION_CHARS);
}

export async function doGenerateImage(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IImageToolDeps = DEFAULT_DEPS
): Promise<string> {
  const cap = await deps.resolveCap("imageGen");

  if (cap === null) {
    return reject(
      ctx,
      "generate_image",
      "image generation is not configured — set an `imageGen` capability in " +
        "~/.tsforge/models.json (or TSFORGE_IMAGE_BASE_URL/TSFORGE_IMAGE_MODEL)."
    );
  }

  const prompt = str(args, "prompt");

  if (prompt.length === 0) {
    return reject(ctx, "generate_image", "a non-empty `prompt` is required");
  }

  const size = str(args, "size");

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ generate_image → ${cap.name}`,
  });

  let images;

  try {
    images = await deps.generate(
      entryConfig(cap.entry),
      {
        prompt,
        api: cap.entry.imageApi,
        ...(size.length > 0 ? { size } : {}),
      },
      { signal: ctx.signal }
    );
  } catch (err) {
    // A decline (content policy) or per-request error — a terse, factual result.
    // Do NOT pack model-steering instructions in here: the model echoes the tool
    // result, so guidance text leaks into the user-facing reply.
    const reason = err instanceof Error ? err.message : String(err);

    return reject(ctx, "generate_image", `image not generated — ${reason}`);
  }

  const outDir = join(ctx.cwd, IMAGE_OUTPUT_DIR);
  const baseName = `image-${randomUUID().slice(0, 8)}`;
  const paths = await deps.save(images, outDir, baseName);

  previewGenerated(ctx, images, paths);

  const rels = paths.map((p) => relative(ctx.cwd, p));

  return `Generated ${String(paths.length)} image(s): ${rels.join(", ")}`;
}

/** Fire the inline-preview hook (when wired) for each saved image. */
function previewGenerated(
  ctx: IToolContext,
  images: IGeneratedImage[],
  paths: string[]
): void {
  if (ctx.previewImage === undefined) {
    return;
  }

  for (let i = 0; i < paths.length; i += 1) {
    const image = images[i];
    const path = paths[i];

    if (image !== undefined && path !== undefined) {
      ctx.previewImage({
        path,
        base64: Buffer.from(image.bytes).toString("base64"),
        mimeType: image.mimeType,
      });
    }
  }
}
