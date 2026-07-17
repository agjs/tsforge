import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundledManifest,
  parseManifest,
} from "../src/scaffold/boringstack-manifest";

describe("bundled scaffold manifest", () => {
  test("loads + validates the manifest shipped in src", () => {
    const m = loadBundledManifest();

    expect(m.manifestVersion).toBeGreaterThan(0);
    expect(m.repo).toContain("boringstack");
    expect(m.fields.length).toBeGreaterThan(10);
  });

  test("stays identical to the test fixture (drift guard)", () => {
    // The fixture is the test double; the src copy is the runtime bootstrap. They
    // mirror boringstack's source-of-truth manifest — if they diverge, this fails.
    const fixture = parseManifest(
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
          "utf8"
        )
      )
    );

    expect(loadBundledManifest()).toEqual(fixture);
  });
});

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The fixture manifest with `askWhen` overrides applied to the named fields. */
function withAskWhens(overrides: Record<string, string>): unknown {
  const raw: unknown = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  );

  if (!isRecordLike(raw) || !Array.isArray(raw.fields)) {
    throw new Error("fixture manifest is malformed");
  }

  for (const f of raw.fields) {
    if (isRecordLike(f) && typeof f.key === "string" && f.key in overrides) {
      f.askWhen = overrides[f.key];
    }
  }

  return raw;
}

/** The fixture manifest with a NON-STRING askWhen forced onto a field, to exercise
 *  the parse-time type guard (optStrField would otherwise silently drop it). */
function withNonStringAskWhen(key: string): unknown {
  const raw: unknown = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  );

  if (!isRecordLike(raw) || !Array.isArray(raw.fields)) {
    throw new Error("fixture manifest is malformed");
  }

  for (const f of raw.fields) {
    if (isRecordLike(f) && f.key === key) {
      f.askWhen = true; // a boolean, not a string
    }
  }

  return raw;
}

describe("askWhen validation (fail-loud)", () => {
  test("rejects a non-string askWhen (would otherwise be silently dropped)", () => {
    expect(() => parseManifest(withNonStringAskWhen("CACHE_PROVIDER"))).toThrow(
      /askWhen must be a string/u
    );
  });

  test("rejects a token with no '='", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "CACHE_ENABLED" }))
    ).toThrow(/KEY=value/u);
  });

  test("rejects an empty key", () => {
    expect(() => parseManifest(withAskWhens({ CACHE_PROVIDER: "=1" }))).toThrow(
      /KEY=value/u
    );
  });

  test("rejects multiple '=' (would silently truncate the value)", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "CACHE_ENABLED=a=b" }))
    ).toThrow(/KEY=value/u);
  });

  test("rejects an empty value", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "CACHE_ENABLED=" }))
    ).toThrow(/empty value/u);
  });

  test("rejects an unknown referenced field", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "NOPE=1" }))
    ).toThrow(/unknown field/u);
  });

  test("rejects a forward/self dependency (must be asked earlier)", () => {
    // CACHE_ENABLED depends on CACHE_PROVIDER, which is asked AFTER it.
    expect(() =>
      parseManifest(withAskWhens({ CACHE_ENABLED: "CACHE_PROVIDER=valkey" }))
    ).toThrow(/asked before it/u);
  });

  test("rejects a chained dependency (gate that itself has askWhen)", () => {
    // CACHE_ENABLED gains an askWhen; CACHE_PROVIDER then depends on it → chain.
    expect(() =>
      parseManifest(
        withAskWhens({
          CACHE_ENABLED: "QUEUES_ENABLED=1",
          CACHE_PROVIDER: "CACHE_ENABLED=1",
        })
      )
    ).toThrow(/chained conditions are not supported/u);
  });

  test('rejects a toggle token with "=true" (wizard records "1"/"0")', () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "CACHE_ENABLED=true" }))
    ).toThrow(/can never match/u);
  });

  test("rejects an impossible one-of value", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "EMAIL_PROVIDER=nope" }))
    ).toThrow(/can never match/u);
  });

  test("rejects a dependency on a multi field (answer lives in state.multi)", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "OAUTH_PROVIDERS=google" }))
    ).toThrow(/not a yes\/no or single-choice/u);
  });

  test("rejects a dependency on STACK (never a wizard question)", () => {
    expect(() =>
      parseManifest(withAskWhens({ CACHE_PROVIDER: "STACK=dev" }))
    ).toThrow(/not a yes\/no or single-choice/u);
  });
});
