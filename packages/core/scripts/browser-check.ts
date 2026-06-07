// Gate-runnable browser check: render an HTML file in headless chromium (served
// over http) and exit non-zero (printing failures) if it errors or fails its
// checks. Used as part of a gate for web builds — proves the page actually runs
// AND behaves.
//
//   bun browser-check.ts <htmlFile>                 # render-only (no errors)
//   bun browser-check.ts <htmlFile> <checks.json>   # render + interaction checks
//   bun browser-check.ts <htmlFile> <selector> [text]
import { renderCheck, parseChecks, type IRenderOptions } from "../src/browser";

const [file, arg2, arg3] = process.argv.slice(2);

if (file === undefined) {
  process.stderr.write(
    "usage: browser-check.ts <htmlFile> [checks.json | selector [text]]\n"
  );
  process.exit(2);
}

async function checksFor(): Promise<Partial<IRenderOptions>> {
  if (arg2 === undefined) {
    return {};
  }

  if (arg2.endsWith(".json")) {
    return parseChecks(JSON.parse(await Bun.file(arg2).text()));
  }

  return {
    expect: { selector: arg2, ...(arg3 !== undefined ? { text: arg3 } : {}) },
  };
}

const result = await renderCheck({ file, ...(await checksFor()) });

if (result.ok) {
  process.stdout.write(`browser-check: ${file} renders + behaves correctly\n`);
  process.exit(0);
}

process.stdout.write(`browser-check FAILED for ${file}:\n`);

for (const error of result.errors) {
  process.stdout.write(`  - ${error}\n`);
}

process.exit(1);
