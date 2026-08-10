/**
 * Seed `profile: "opinionated"` so STRUCTURE_RULES gate for React greenfield.
 *
 * Call ONLY from React-owned entry points (e.g. boringstack scaffold handoff).
 * Never from generic gate/session setup — non-React projects must not pay this tax.
 * Empty Vite scratch builds opt in with `--profile opinionated` or a recipe profile.
 */
import { join } from "node:path";
import { isRecord } from "../lib/guards";

const CONFIG_FILE = "tsforge.config.json";

export type SeedGreenfieldProfileResult =
  | { readonly seeded: false; readonly reason: string }
  | { readonly seeded: true; readonly path: string };

function hasOwnProfile(root: Record<string, unknown>): boolean {
  return typeof root.profile === "string" && root.profile.length > 0;
}

/** True when package.json lists react. */
async function packageJsonHasReact(cwd: string): Promise<boolean> {
  const pkgFile = Bun.file(join(cwd, "package.json"));

  if (!(await pkgFile.exists())) {
    return false;
  }

  try {
    const raw: unknown = await pkgFile.json();

    if (!isRecord(raw)) {
      return false;
    }

    const deps = isRecord(raw.dependencies) ? raw.dependencies : {};
    const devDeps = isRecord(raw.devDependencies) ? raw.devDependencies : {};

    return Object.hasOwn(deps, "react") || Object.hasOwn(devDeps, "react");
  } catch {
    return false;
  }
}

/**
 * Write `{ "profile": "opinionated" }` (merged) when cwd has react and no profile yet.
 * Idempotent — never overwrites an explicit profile.
 */
export async function seedReactGreenfieldOpinionated(
  cwd: string
): Promise<SeedGreenfieldProfileResult> {
  if (!(await packageJsonHasReact(cwd))) {
    return { seeded: false, reason: "no react dependency" };
  }

  const configPath = join(cwd, CONFIG_FILE);
  const configFile = Bun.file(configPath);
  let existing: Record<string, unknown> = {};

  if (await configFile.exists()) {
    try {
      const parsed: unknown = JSON.parse(await configFile.text());

      if (!isRecord(parsed)) {
        return { seeded: false, reason: "existing config is not an object" };
      }

      existing = parsed;
    } catch {
      return { seeded: false, reason: "existing config is invalid JSON" };
    }

    if (hasOwnProfile(existing)) {
      return { seeded: false, reason: "profile already set" };
    }
  }

  const merged = { ...existing, profile: "opinionated" };

  await Bun.write(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  return { seeded: true, path: CONFIG_FILE };
}
