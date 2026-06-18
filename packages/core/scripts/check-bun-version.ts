/**
 * Preflight for `bun run validate`: compare the running Bun against the version
 * this repo pins (`packages/core/package.json` → `engines.bun`). A mismatch is the
 * usual cause of otherwise-inexplicable local flakes — most notably the boot/render
 * oracles' `Bun.serve({ port: 0 })` intermittently throwing EADDRINUSE on builds
 * older than the pin. We WARN by default (so a dev on a slightly-off Bun isn't
 * hard-blocked) and only fail when `TSFORGE_ENFORCE_BUN=1` (CI sets this), so the
 * pinned version is enforced where it must be and merely flagged where it needn't.
 */

import { isRecord } from "../src/lib/guards";

/** Strip range/range-prefix noise (`>=`, `^`, `~`, `bun@`) and split into numeric
 *  parts. Non-numeric/blank parts become 0 so a malformed string can't crash. */
export function parseVersion(raw: string): number[] {
  const cleaned = raw
    .trim()
    .replace(/^bun@/, "")
    .replace(/^[\^~]|^>=|^>/g, "");

  return cleaned
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/** True when `current` is at least `pinned` (semver-ish numeric compare). */
export function meetsPinned(current: string, pinned: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(pinned);
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;

    if (x !== y) {
      return x > y;
    }
  }

  return true;
}

/** Read the pinned Bun version from this package's `engines.bun`. */
async function pinnedBunVersion(): Promise<string> {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg: unknown = await Bun.file(pkgUrl).json();
  const engines = isRecord(pkg) ? pkg.engines : undefined;
  const bun = isRecord(engines) ? engines.bun : undefined;

  return typeof bun === "string" ? bun : "";
}

async function main(): Promise<void> {
  const pinned = await pinnedBunVersion();

  if (pinned === "" || meetsPinned(Bun.version, pinned)) {
    return;
  }

  const enforce = process.env.TSFORGE_ENFORCE_BUN === "1";
  const head = enforce ? "✗ Bun version too old" : "⚠ Bun version mismatch";

  process.stderr.write(
    `${head}: running ${Bun.version}, this repo pins ${pinned}.\n` +
      "  Older builds intermittently fail the boot/render oracles with EADDRINUSE.\n" +
      "  Upgrade with: bun upgrade --to " +
      `${parseVersion(pinned).join(".")}\n` +
      (enforce ? "" : "  (set TSFORGE_ENFORCE_BUN=1 to make this fatal)\n")
  );

  if (enforce) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
