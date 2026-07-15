import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "../lib/guards/guards";
import { OpenAICompatibleProvider, type IProvider } from "../inference";
import {
  loadModelsConfig,
  resolveActiveModel,
  resolveApiKey,
  type IModelEntry,
  type BinaryInputMode,
} from "../models-config";
import { resolvePanel } from "../reviewers/registry";
import {
  runHarnessReview,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHARS,
  verdictCacheKey,
  artifactBody,
} from "../reviewers/harness-review";
import { RUBRIC_VERSION } from "../reviewers/schema";
import type { IVerdict } from "../reviewers/aggregate";

interface IArgs {
  base: string | undefined;
  intent: string | undefined;
  quick: boolean;
  ci: boolean;
  installHook: boolean;
}

function parse(argv: string[]): IArgs {
  const out: IArgs = {
    base: undefined,
    intent: undefined,
    quick: false,
    ci: false,
    installHook: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === "--quick") {
      out.quick = true;
    } else if (a === "--ci") {
      out.ci = true;
    } else if (a === "--install-hook") {
      out.installHook = true;
    } else if (a === "--intent") {
      i += 1;
      out.intent = argv[i];
    } else if (a === "--base") {
      i += 1;
      out.base = argv[i];
    }
  }

  return out;
}

function providerConfig(
  entry: IModelEntry
): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
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

function makeProvider(entry: IModelEntry): IProvider {
  return new OpenAICompatibleProvider(providerConfig(entry));
}

async function runBinary(
  r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
  stdin: string
): Promise<{ ok: boolean; stdout: string }> {
  const cmd = r.input === "arg" ? [...r.argv, stdin] : [...r.argv];
  const proc = Bun.spawn(cmd, {
    stdin: r.input === "stdin" ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    proc.kill();
  }, r.timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;

    return { ok: code === 0, stdout };
  } finally {
    clearTimeout(timer);
  }
}

async function gitRunner(
  args: string[]
): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;

  return { stdout, code };
}

async function validateRunner(): Promise<{
  passed: boolean;
  failCount: number;
  firstErrors: string[];
}> {
  const proc = Bun.spawn(["bun", "run", "validate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;
  const firstErrors = text
    .split("\n")
    .filter((l) => /error/iu.test(l))
    .slice(0, 20);

  return { passed: code === 0, failCount: firstErrors.length, firstErrors };
}

function computePanelHash(panel: object): string {
  return createHash("sha256").update(JSON.stringify(panel)).digest("hex");
}

async function readCachedVerdict(cacheKey: string): Promise<IVerdict | null> {
  try {
    const path = join(".tsforge", "harness-review", `${cacheKey}.json`);
    const content = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (!isRecord(parsed) || !("verdict" in parsed)) {
      return null;
    }

    const verdict = parsed.verdict;

    if (
      verdict !== undefined &&
      verdict !== null &&
      isRecord(verdict) &&
      typeof verdict.blocked === "boolean" &&
      typeof verdict.reason === "string" &&
      isRecord(verdict.reviewers) &&
      Array.isArray(verdict.ranked) &&
      Array.isArray(verdict.perReviewer) &&
      typeof verdict.identity === "string"
    ) {
      return verdict as unknown as IVerdict;
    }

    return null;
  } catch {
    return null;
  }
}

async function writeCachedVerdict(
  cacheKey: string,
  verdict: IVerdict,
  treeHash: string,
  panelHash: string
): Promise<void> {
  const dir = join(".tsforge", "harness-review");
  const path = join(dir, `${cacheKey}.json`);
  const body = artifactBody(verdict, {
    treeHash,
    panelHash,
    when: new Date().toISOString(),
  });

  await mkdir(dir, { recursive: true });
  await writeFile(path, body, "utf-8");
}

export function formatVerdict(v: IVerdict): string {
  const head = v.blocked ? "BLOCK" : "PASS";
  const lines = [
    `harness-review: ${head} — ${v.reason}`,
    `reviewers ok: ${String(v.reviewers.ok)}  errored: ${String(v.reviewers.errored)}  (builder: ${v.identity})`,
  ];

  for (const f of v.ranked) {
    lines.push(
      `  [${f.severity}/${f.findingCode}] ${f.file ?? "?"} — ${f.issue} (agreement ${String(f.agreement)})`
    );
  }

  return lines.join("\n");
}

export async function harnessReviewMode(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (args.installHook) {
    process.stdout.write(
      "Run: git config core.hooksPath .githooks (see .githooks/pre-push)\n"
    );

    return 0;
  }

  const cfg = await loadModelsConfig();
  const active = await resolveActiveModel();
  const panel = resolvePanel(cfg, active);

  for (const s of panel.skipped) {
    process.stdout.write(`skipped reviewer ${s.id}: ${s.reason}\n`);
  }

  const effective = args.quick
    ? { ...panel, reviewers: panel.reviewers.slice(0, 1) }
    : panel;

  const treeHashRes = await gitRunner(["write-tree"]);
  const treeHash = treeHashRes.stdout.trim();
  const panelHash = computePanelHash(cfg.reviewPanel ?? {});
  const cacheKey = verdictCacheKey({
    treeHash,
    panelHash,
    rubricVersion: RUBRIC_VERSION,
  });

  let verdict: IVerdict;

  if (!args.ci) {
    const cached = await readCachedVerdict(cacheKey);

    if (cached !== null) {
      process.stdout.write("harness-review: cache hit, reusing verdict\n");
      verdict = cached;
    } else {
      verdict = await runHarnessReview(
        {
          git: gitRunner,
          validate: validateRunner,
          makeProvider,
          runBinary,
          panel: effective,
          identity: `${active.name}/${active.entry.model}`,
        },
        {
          base: args.base,
          intent: args.intent,
          maxFiles: DEFAULT_MAX_FILES,
          maxChars: DEFAULT_MAX_CHARS,
        }
      );
      await writeCachedVerdict(cacheKey, verdict, treeHash, panelHash);
    }
  } else {
    verdict = await runHarnessReview(
      {
        git: gitRunner,
        validate: validateRunner,
        makeProvider,
        runBinary,
        panel: effective,
        identity: `${active.name}/${active.entry.model}`,
      },
      {
        base: args.base,
        intent: args.intent,
        maxFiles: DEFAULT_MAX_FILES,
        maxChars: DEFAULT_MAX_CHARS,
      }
    );
    await writeCachedVerdict(cacheKey, verdict, treeHash, panelHash);
  }

  process.stdout.write(`${formatVerdict(verdict)}\n`);

  return verdict.blocked ? 1 : 0;
}
