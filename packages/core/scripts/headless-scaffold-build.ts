// Non-interactive scaffold entry — the eval/automation seam for the boringstack
// wizard. Parses flags → answers, clones boringstack at the manifest ref,
// configures it via boringstack's own scripts, optionally boots the stack, and
// prints the handoff (where + how the harness then runs the gate).
//
// Mirrors the interactive `--scaffold` wizard's output (answers → runScaffold) so
// the two paths share one engine. The model-driven build loop is a separate step
// (hand `gateCwd` + `gateCommand` to the greenfield loop) — wired by the CLI.
//
//   bun headless-scaffold-build.ts --dest /tmp/acme \
//     --set project=acme --set ghcrOwner=acme-corp --set domain=acme.com \
//     --set WITH_OBSERVABILITY=0 --multi OAUTH_PROVIDERS=google --no-boot
//
// Secret VALUES are never printed (org rule); the summary shows keys only.

import { loadBundledManifest } from "../src/scaffold/boringstack-manifest";
import { parseScaffoldArgs } from "../src/scaffold/scaffold-cli";
import { runScaffold } from "../src/scaffold/run-scaffold";
import { realRunner, realFs, realPoller } from "../src/scaffold/io";
import type { IScaffoldManifest } from "../src/scaffold/scaffold.types";

/** Apply a `--ref` override and the `BORINGSTACK_REPO` env override (the latter
 *  lets dev/E2E clone a local checkout instead of GitHub). */
function withOverrides(
  manifest: IScaffoldManifest,
  ref: string
): IScaffoldManifest {
  const repo = process.env.BORINGSTACK_REPO;

  return {
    ...manifest,
    ...(ref.length > 0 ? { defaultRef: ref } : {}),
    ...(repo !== undefined && repo.length > 0 ? { repo } : {}),
  };
}

async function main(): Promise<number> {
  const opts = parseScaffoldArgs(process.argv.slice(2));
  const manifest = withOverrides(loadBundledManifest(), opts.ref);

  process.stdout.write(
    `scaffold: ${opts.answers.archetype} (${opts.answers.stack}) → ${opts.dest}\n` +
      `  repo ${manifest.repo}@${manifest.defaultRef}${opts.skipBoot ? "  [--no-boot]" : ""}\n`
  );

  const outcome = await runScaffold(manifest, opts.answers, opts.dest, {
    run: realRunner,
    fs: realFs,
    boot: { poll: realPoller },
    skipBoot: opts.skipBoot,
  });

  process.stdout.write(
    [
      "",
      `cloned    ${outcome.resolvedSha}`,
      `booted    ${String(outcome.booted)}${outcome.bootError === undefined ? "" : ` (${outcome.bootError})`}`,
      `gate (cd ${outcome.gateCwd})`,
      `          ${outcome.gateCommand}`,
      "",
      ...(Object.keys(outcome.ports).length > 0
        ? [
            "host ports (isolated — safe alongside the dev stack):",
            `  api  ${String(outcome.ports.API_HOST_PORT)}   ui  ${String(outcome.ports.UI_HOST_PORT)}   postgres  ${String(outcome.ports.POSTGRES_HOST_PORT)}`,
            "",
          ]
        : []),
      "configured .env:",
      ...outcome.summary.map((l) => `  ${l}`),
      "",
      "next: run the greenfield loop against gateCwd with gateCommand as the gate.",
      "",
    ].join("\n")
  );

  // A boringstack boot that was requested but didn't come up is a hard failure.
  return !opts.skipBoot && outcome.bootError !== undefined ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `scaffold failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
