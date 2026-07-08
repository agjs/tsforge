import { isAbsolute, resolve, basename } from "node:path";
import {
  resolveVisionConfig,
  loadImageFile,
  isSupportedImagePath,
} from "../loop/tools/image-tools";
import { describeImage, DEFAULT_VISION_PROMPT } from "../inference/vision";
import type { IOpenAICompatibleConfig } from "../inference";
import type { IImageInput } from "../inference/vision";

/**
 * The interactive image-attachment flow: turn images a user drops onto the
 * session (a dragged path, an `@`-mentioned image, or a clipboard temp file) into
 * TEXT the primary model can use. The image is sent to the configured vision
 * backend and its description is injected into the outgoing message — the core
 * message stays plain text (see the delegation rationale in inference/vision.ts).
 */
const IMAGE_EXT = "(?:png|jpe?g|gif|webp)";

// A quoted image path (single or double quotes; may contain spaces).
const QUOTED = new RegExp(
  `(['"])((?:\\\\.|(?!\\1).)*\\.${IMAGE_EXT})\\1`,
  "giu"
);

// An unquoted, optionally `@`-prefixed image path token; backslash-escaped spaces
// (how a terminal drag-drop escapes them) are part of the token.
const BARE = new RegExp(
  `(^|\\s)@?((?:\\\\ |[^\\s'"])*\\.${IMAGE_EXT})(?=\\s|$)`,
  "giu"
);

export interface IExtractedImages {
  /** The line with image tokens replaced by an inline `[image: name]` marker. */
  cleanedLine: string;
  /** Absolute paths of the referenced images, in first-seen order. */
  paths: string[];
}

/** Pull image references out of a submitted line (quoted, `@`-mentioned, dragged)
 *  and resolve them to absolute paths against `cwd`. Non-image tokens are left
 *  untouched so ordinary `@file` mentions still flow to composeMessage. */
export function extractImagePaths(line: string, cwd: string): IExtractedImages {
  const toAbs = (raw: string): string => {
    const unescaped = raw.replace(/\\ /g, " ");

    return isAbsolute(unescaped) ? unescaped : resolve(cwd, unescaped);
  };

  // Collect matches from the ORIGINAL line WITH their positions, so paths come out
  // in reading order (their descriptions then line up with the inline markers),
  // regardless of which pattern matched.
  const hits: { abs: string; index: number }[] = [];

  for (const m of line.matchAll(QUOTED)) {
    if (m[2] !== undefined) {
      hits.push({ abs: toAbs(m[2]), index: m.index });
    }
  }

  for (const m of line.matchAll(BARE)) {
    if (m[2] !== undefined) {
      hits.push({ abs: toAbs(m[2]), index: m.index + (m[1]?.length ?? 0) });
    }
  }

  const paths: string[] = [];

  for (const { abs } of hits.sort((a, b) => a.index - b.index)) {
    if (!paths.includes(abs)) {
      paths.push(abs);
    }
  }

  const marker = (raw: string): string =>
    `[image: ${basename(raw.replace(/\\ /g, " "))}]`;
  const cleaned = line
    .replace(QUOTED, (_whole, _q: string, path: string) => marker(path))
    .replace(
      BARE,
      (_whole, pre: string, path: string) => `${pre}${marker(path)}`
    );

  return { cleanedLine: cleaned, paths };
}

export interface IResolveImageInputDeps {
  resolveVision: () => Promise<IOpenAICompatibleConfig | null>;
  load: (absPath: string) => Promise<IImageInput | null>;
  describe: typeof describeImage;
}

const DEFAULT_DEPS: IResolveImageInputDeps = {
  resolveVision: resolveVisionConfig,
  load: loadImageFile,
  describe: describeImage,
};

export interface IResolvedImageInput {
  /** The user's line with image tokens replaced by `[image: name]` markers. */
  cleanedLine: string;
  /** Text describing each attached image, to prepend to the outgoing message
   *  (empty when there are no images). */
  contextBlock: string;
  imageCount: number;
}

/**
 * Resolve every image referenced in `rawLine` (plus any `extraPaths`, e.g.
 * clipboard temp files) into a description block via the vision backend. When no
 * vision backend is configured, a short note is injected instead of a description
 * so the model (and user) knows why the image wasn't read.
 */
export async function resolveImageInput(
  rawLine: string,
  cwd: string,
  opts: { extraPaths?: string[]; deps?: IResolveImageInputDeps } = {}
): Promise<IResolvedImageInput> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const { cleanedLine, paths } = extractImagePaths(rawLine, cwd);
  const all = [...paths, ...(opts.extraPaths ?? [])];

  if (all.length === 0) {
    return { cleanedLine, contextBlock: "", imageCount: 0 };
  }

  const vision = await deps.resolveVision();

  if (vision === null) {
    return {
      cleanedLine,
      contextBlock: `[${String(all.length)} image(s) attached, but no vision backend is configured — set capabilities.vision in ~/.tsforge/models.json to read them.]\n\n`,
      imageCount: all.length,
    };
  }

  const prompt =
    cleanedLine.trim().length > 0 ? cleanedLine.trim() : DEFAULT_VISION_PROMPT;
  const blocks: string[] = [];

  for (const abs of all) {
    const image = await deps.load(abs);

    if (image === null) {
      blocks.push(`[Attached image "${basename(abs)}": could not read file]`);
      continue;
    }

    try {
      const text = await deps.describe(vision, { prompt, images: [image] });

      blocks.push(`[Attached image "${basename(abs)}":\n${text}\n]`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      blocks.push(
        `[Attached image "${basename(abs)}": vision failed — ${message}]`
      );
    }
  }

  return {
    cleanedLine,
    contextBlock: `${blocks.join("\n\n")}\n\n`,
    imageCount: all.length,
  };
}

/** True when a bare path (e.g. a drag-dropped token) points at a supported image
 *  — used to decide whether a dropped path should be treated as an attachment. */
export { isSupportedImagePath };
