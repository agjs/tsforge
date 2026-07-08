import { test, expect } from "bun:test";
import {
  readClipboardImage,
  readClipboardText,
  captureClipboardImageToFile,
  type IClipboardDeps,
} from "../src/lib/clipboard/clipboard-image";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function deps(over: Partial<IClipboardDeps>): IClipboardDeps {
  return {
    platform: "darwin",
    run: async () => 1,
    readFileBytes: async () => null,
    ...over,
  };
}

test("non-macOS platforms return null (REPL falls back to text paste)", async () => {
  const out = await readClipboardImage(
    deps({
      platform: "linux",
      run: async () => 0,
      readFileBytes: async () => PNG,
    })
  );

  expect(out).toBeNull();
});

test("pngpaste success returns base64 PNG without trying osascript", async () => {
  const argvs: string[][] = [];
  const out = await readClipboardImage(
    deps({
      run: async (argv) => {
        argvs.push(argv);

        return argv[0] === "pngpaste" ? 0 : 1;
      },
      readFileBytes: async () => PNG,
    })
  );

  expect(out?.mimeType).toBe("image/png");
  expect(out?.base64).toBe(Buffer.from(PNG).toString("base64"));
  // osascript must NOT be invoked once pngpaste succeeds
  expect(argvs.map((a) => a[0])).toEqual(["pngpaste"]);
});

test("falls back to osascript when pngpaste is missing", async () => {
  const argvs: string[][] = [];
  const out = await readClipboardImage(
    deps({
      run: async (argv) => {
        argvs.push(argv);

        // pngpaste missing → 127; osascript succeeds
        return argv[0] === "osascript" ? 0 : 127;
      },
      readFileBytes: async (path) => (path.endsWith(".png") ? PNG : null),
    })
  );

  expect(out?.base64).toBe(Buffer.from(PNG).toString("base64"));
  expect(argvs.map((a) => a[0])).toEqual(["pngpaste", "osascript"]);
  // osascript is invoked with the temp path as a POSIX file argument
  expect(argvs[1]?.join(" ")).toContain("class PNGf");
});

test("no image on clipboard (empty file) returns null after trying both", async () => {
  const out = await readClipboardImage(
    deps({ run: async () => 0, readFileBytes: async () => null })
  );

  expect(out).toBeNull();
});

test("readClipboardText: returns pbpaste stdout on macOS, '' elsewhere", async () => {
  const text = await readClipboardText({
    platform: "darwin",
    run: async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === "pbpaste" ? "hello clip" : "",
    }),
  });

  expect(text).toBe("hello clip");

  const linux = await readClipboardText({
    platform: "linux",
    run: async () => ({ exitCode: 0, stdout: "x" }),
  });

  expect(linux).toBe("");
});

test("captureClipboardImageToFile: keeps the written temp path, no re-encode", async () => {
  // pngpaste 'writes' the file (faked) and readFileBytes confirms non-empty →
  // returns that path directly (no read-back + base64 + rewrite).
  const path = await captureClipboardImageToFile(
    deps({
      run: async (argv) => (argv[0] === "pngpaste" ? 0 : 1),
      readFileBytes: async () => PNG,
    })
  );

  expect(path).toMatch(/tsforge-paste-.*\.png$/);

  // no image on clipboard → null
  expect(
    await captureClipboardImageToFile(
      deps({ run: async () => 0, readFileBytes: async () => null })
    )
  ).toBeNull();

  // non-macOS → null
  expect(
    await captureClipboardImageToFile(deps({ platform: "linux" }))
  ).toBeNull();
});

test("readClipboardText: non-zero exit → empty string", async () => {
  const text = await readClipboardText({
    platform: "darwin",
    run: async () => ({ exitCode: 1, stdout: "junk" }),
  });

  expect(text).toBe("");
});
