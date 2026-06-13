// Gate-runnable browser check: render an HTML file in headless chromium (served
// over http) and exit non-zero (printing failures) if it errors or fails its
// checks. Used as part of a gate for web builds — proves the page actually runs
// AND behaves.
//
//   bun browser-check.ts <htmlFile>                 # render-only (no errors)
//   bun browser-check.ts <htmlFile> --smoke         # render + generic behaviour smoke
//   bun browser-check.ts <htmlFile> --a11y          # + axe accessibility (serious/critical fail)
//   bun browser-check.ts <htmlFile> --screenshots[=dir]  # + per-route PNGs (artifact)
//   bun browser-check.ts <htmlFile> --perf          # + a basic DOM-size/mount-time budget
//   bun browser-check.ts <htmlFile> <checks.json>   # render + interaction checks
//   bun browser-check.ts <htmlFile> <selector> [text]
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  renderCheck,
  parseChecks,
  type IRenderOptions,
  type IPerfBudget,
} from "../src/browser";
import { crawlableRoutePaths } from "../src/web-routes";

const rawArgs = process.argv.slice(2);
const smoke = rawArgs.includes("--smoke");
const crawl = rawArgs.includes("--crawl");
const a11y = rawArgs.includes("--a11y");
const perf = rawArgs.includes("--perf");
const screenshotsArg = rawArgs.find((a) => a.startsWith("--screenshots"));
// Positionals are anything that isn't a recognized `--flag`.
const [file, arg2, arg3] = rawArgs.filter((a) => !a.startsWith("--"));

if (file === undefined) {
  process.stderr.write(
    "usage: browser-check.ts <htmlFile> [--smoke] [--crawl] [--a11y] " +
      "[--screenshots[=dir]] [--perf] [checks.json | selector [text]]\n"
  );
  process.exit(2);
}

/** A conservative default budget — a tripwire for runaway render trees / slow
 *  mounts, not a tuned Lighthouse target. */
const DEFAULT_PERF_BUDGET: IPerfBudget = {
  maxDomNodes: 5000,
  maxMountMs: 6000,
};

/** The screenshot dir: `--screenshots=<dir>`, else a `screenshots/` folder next
 *  to the HTML file. undefined when `--screenshots` wasn't passed. */
function screenshotDir(): string | undefined {
  if (screenshotsArg === undefined) {
    return undefined;
  }

  const eq = screenshotsArg.indexOf("=");

  return eq === -1
    ? join(dirname(file ?? "."), "screenshots")
    : screenshotsArg.slice(eq + 1);
}

/** With --crawl, enumerate the app's static routes from `<buildDir>/src/routes/`
 *  (the build dir is the parent of dist/) so every page — not just the home —
 *  is render-checked. Dynamic ($param) routes are skipped. */
async function routesFor(): Promise<string[]> {
  if (!crawl) {
    return [];
  }

  const routesDir = join(dirname(dirname(file ?? ".")), "src", "routes");

  try {
    const files = await readdir(routesDir);

    return crawlableRoutePaths(files.filter((f) => f.endsWith(".tsx")));
  } catch {
    return [];
  }
}

async function checksFor(): Promise<Partial<IRenderOptions>> {
  if (arg2 === undefined) {
    return {};
  }

  if (arg2.endsWith(".json")) {
    const file = Bun.file(arg2);

    // Tolerate a missing checks file → render-only (the model may not write one).
    if (!(await file.exists())) {
      return {};
    }

    return parseChecks(JSON.parse(await file.text()));
  }

  return {
    expect: { selector: arg2, ...(arg3 !== undefined ? { text: arg3 } : {}) },
  };
}

const shots = screenshotDir();
const result = await renderCheck({
  file,
  smoke,
  a11y,
  routes: await routesFor(),
  ...(perf ? { perfBudget: DEFAULT_PERF_BUDGET } : {}),
  ...(shots !== undefined ? { screenshotDir: shots } : {}),
  ...(await checksFor()),
});

if (result.ok) {
  process.stdout.write(`browser-check: ${file} renders + behaves correctly\n`);
  process.exit(0);
}

process.stdout.write(`browser-check FAILED for ${file}:\n`);

for (const error of result.errors) {
  process.stdout.write(`  - ${error}\n`);
}

process.exit(1);
