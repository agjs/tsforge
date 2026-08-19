import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { runArgvCommand } from "../fs/process";

/**
 * Read an image off the system clipboard (Ctrl+V of image bytes, like the drag/
 * paste UX in Claude Code). Deliberately SHELL-BASED, not a native addon: tsforge
 * runs on Bun with no Rust natives crate, so we shell out to `pngpaste` (if
 * installed) or `osascript` on macOS. Both WRITE a PNG to a temp file, which we
 * then read as bytes — no binary-through-a-string-pipe.
 *
 * macOS-only today (returns null elsewhere) so the REPL cleanly falls through to
 * a normal text paste; Linux (`wl-paste`/`xclip`) and WSL are structured to slot
 * in behind the same `platform` switch later.
 */
export interface IClipboardImage {
  /** Base64 (no data-URI prefix). */
  base64: string;
  mimeType: string;
}

export interface IClipboardDeps {
  platform: NodeJS.Platform;
  /** Run an argv (no shell); resolves to the exit code. The command is expected
   *  to WRITE the clipboard image to its last argument (a file path). */
  run: (argv: string[]) => Promise<number>;
  /** Read the bytes a command wrote, or null if the file is missing/empty. */
  readFileBytes: (path: string) => Promise<Uint8Array | null>;
}

/** AppleScript that writes the clipboard's PNG to `path`. Wrapped in try/finally
 *  so the file handle always closes; if the clipboard holds no image the write
 *  throws and the file stays empty (→ treated as "no image"). */
function osascriptArgs(path: string): string[] {
  const script = [
    `set f to (open for access (POSIX file ${JSON.stringify(path)}) with write permission)`,
    "try",
    "write (the clipboard as «class PNGf») to f",
    "end try",
    "close access f",
  ];

  return ["osascript", ...script.flatMap((line) => ["-e", line])];
}

/** Cap on a pasted clipboard image (bytes). Without it a huge paste (a
 *  multi-hundred-MB screenshot/PSD) was read whole and then base64-encoded
 *  (~1.33× more) into a string held in the REPL attachment — mirrors the
 *  MAX_FILE_BYTES bound every workspace read already has. */
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

/** A clipboard image of `size` bytes is readable: non-empty and within the cap. */
export function clipboardImageSizeOk(size: number): boolean {
  return size > 0 && size <= MAX_CLIPBOARD_IMAGE_BYTES;
}

const DEFAULT_DEPS: IClipboardDeps = {
  platform: process.platform,
  run: async (argv) =>
    (await runArgvCommand(tmpdir(), argv, { timeoutMs: 5_000 })).exitCode,
  readFileBytes: async (path) => {
    const file = Bun.file(path);

    if (!(await file.exists()) || !clipboardImageSizeOk(file.size)) {
      return null;
    }

    return new Uint8Array(await file.arrayBuffer());
  },
};

/** Return the clipboard image, or null when there is none (or the platform isn't
 *  supported). Tries `pngpaste` first (fast), then `osascript`. */
export async function readClipboardImage(
  deps: IClipboardDeps = DEFAULT_DEPS
): Promise<IClipboardImage | null> {
  if (deps.platform !== "darwin") {
    return null;
  }

  const path = join(tmpdir(), `tsforge-clip-${randomUUID()}.png`);

  try {
    const bytes =
      (await tryCommand(deps, ["pngpaste", path], path)) ??
      (await tryCommand(deps, osascriptArgs(path), path));

    return bytes === null
      ? null
      : {
          base64: Buffer.from(bytes).toString("base64"),
          mimeType: "image/png",
        };
  } finally {
    await unlink(path).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/** Capture a clipboard image to a temp PNG and return its path (or null when
 *  there's no image / unsupported platform). The REPL's Ctrl+V handler calls this
 *  and hands the path to the attachment flow — keeping node fs/os/crypto out of
 *  repl.ts. The temp file lives until the OS reaps tmpdir. */
export async function captureClipboardImageToFile(
  deps: IClipboardDeps = DEFAULT_DEPS
): Promise<string | null> {
  if (deps.platform !== "darwin") {
    return null;
  }

  // `pngpaste`/`osascript` write the PNG straight to `path`, so keep that file as
  // the result instead of reading it back + re-encoding + re-writing (which the
  // old readClipboardImage round-trip did). `tryCommand` returning bytes just
  // confirms a non-empty write.
  const path = join(tmpdir(), `tsforge-paste-${randomUUID()}.png`);
  const wrote =
    (await tryCommand(deps, ["pngpaste", path], path)) ??
    (await tryCommand(deps, osascriptArgs(path), path));

  if (wrote === null) {
    await unlink(path).catch(() => {
      /* nothing was written */
    });

    return null;
  }

  return path;
}

/** Best-effort delete of clipboard temp files (from captureClipboardImageToFile)
 *  once they've been consumed on send, or abandoned (chip deleted / buffer
 *  cleared) — so they don't accumulate in tmpdir. Never throws. */
export async function discardClipboardImages(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((path) =>
      unlink(path).catch(() => {
        /* already gone / not ours */
      })
    )
  );
}

export interface IClipboardTextDeps {
  platform: NodeJS.Platform;
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
}

const DEFAULT_TEXT_DEPS: IClipboardTextDeps = {
  platform: process.platform,
  run: (argv) => runArgvCommand(tmpdir(), argv, { timeoutMs: 5_000 }),
};

/** Read the clipboard as TEXT (macOS `pbpaste`), or "" when empty/unsupported.
 *  The fallback when a Ctrl+V paste held no image, so the shortcut still pastes
 *  text (Cmd+V's terminal bracketed-paste is the usual text path). */
export async function readClipboardText(
  deps: IClipboardTextDeps = DEFAULT_TEXT_DEPS
): Promise<string> {
  if (deps.platform !== "darwin") {
    return "";
  }

  const result = await deps.run(["pbpaste"]).catch(() => null);

  return result !== null && result.exitCode === 0 ? result.stdout : "";
}

/** Run one clipboard command; return the bytes it wrote, or null if it failed /
 *  wrote nothing (missing binary → exit 127, no-image → empty file). */
async function tryCommand(
  deps: IClipboardDeps,
  argv: string[],
  path: string
): Promise<Uint8Array | null> {
  const code = await deps.run(argv).catch(() => 1);

  if (code !== 0) {
    return null;
  }

  return deps.readFileBytes(path);
}
