/**
 * EXPERT HANDOFF — the rung ABOVE the steering ladder. When escalating steers
 * can't unblock the model on a stuck file, hand that single file + its exact gate
 * error to a stronger "expert" model (configured via `capabilities.expert` in
 * models.json, same routing as vision/imageGen). The expert returns the corrected
 * file; the harness applies it and the PRIMARY model continues from there. Only if
 * no expert is configured (or it can't help) does the run finally park — with all
 * work kept, never discarded.
 *
 * The model call is injected (`ExpertAsk`) so the loop wires the real provider and
 * tests stub it; the pure pieces (prompt, code extraction, apply) are unit-tested.
 */
import { stat } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";

import { flags } from "../config";

import { OpenAICompatibleProvider } from "../inference";
import type { IOpenAICompatibleConfig } from "../inference";
import { resolveCapabilityModel, resolveApiKey } from "../models-config";
import type { IModelEntry } from "../models-config";

/** What the expert is told about the stuck file. */
export interface IExpertRequest {
  /** The workspace-relative file that keeps failing. */
  readonly file: string;
  /** Its current full content. */
  readonly content: string;
  /** The exact gate error(s) for this file (message + rule), verbatim. */
  readonly error: string;
  /** A brief line of task context (what's being built). */
  readonly goal: string;
}

/** The result of a handoff attempt, for the loop to log and act on. */
export interface IExpertOutcome {
  readonly applied: boolean;
  readonly file?: string;
  readonly note: string;
}

/** Ask an expert model to fix a stuck file; resolve to the corrected FULL file
 *  content, or null if it can't/won't help. Injected for testability. */
export type ExpertAsk = (req: IExpertRequest) => Promise<string | null>;

const EXPERT_SYSTEM =
  "You are a senior TypeScript engineer called in to unblock an automated agent " +
  "that is STUCK on one file — it keeps failing the same gate check. Return the " +
  "corrected file and nothing else. Obey the project's strict rules: no `as` type " +
  "casts (narrow with a type guard), no `!` non-null assertions, no inline " +
  "types/constants/helpers in a component file, no computation inside JSX.";

/** The scoped fix request. Pure — unit-tested. */
export function buildFixPrompt(req: IExpertRequest): string {
  return (
    `Project goal: ${req.goal}\n\n` +
    `The file \`${req.file}\` fails the build gate with:\n${req.error}\n\n` +
    `Current contents of \`${req.file}\`:\n\`\`\`tsx\n${req.content}\n\`\`\`\n\n` +
    `Return ONLY the corrected FULL contents of \`${req.file}\` in a single \`\`\`tsx ` +
    `code block. Fix the exact error above while keeping everything else working. ` +
    `No explanation.`
  );
}

/** The fenced code block from a model reply, or the raw reply when it's plainly a
 *  file (has an import/export/statement). Null when there's nothing usable — so a
 *  chatty "I can't help" reply doesn't get written to disk. Pure — unit-tested. */
export function extractCode(reply: string): string | null {
  const fenced = /```(?:tsx?|typescript|jsx?)?\n([\s\S]*?)```/u.exec(reply);

  if (fenced?.[1] !== undefined) {
    const body = fenced[1].trim();

    return body.length > 0 ? body : null;
  }

  const raw = reply.trim();

  return /\b(import|export|const|function|class)\b/u.test(raw) ? raw : null;
}

/** Attempt the handoff: ask the expert, and if it returns usable code, OVERWRITE the
 *  stuck file with it. (This is the one place the harness rewrites a whole file — it
 *  is the expert's deliberate repair, not the primary model flailing.) Returns what
 *  happened, for the loop to log. Never throws — a handoff failure must not crash the
 *  run; it just means the run parks instead. */
export async function runExpertHandoff(
  cwd: string,
  req: IExpertRequest,
  ask: ExpertAsk
): Promise<IExpertOutcome> {
  const reply = await ask(req).catch(() => null);
  const code = reply === null ? null : extractCode(reply);

  if (code === null) {
    return {
      applied: false,
      note: "expert unavailable or produced no usable fix",
    };
  }

  try {
    await Bun.write(join(cwd, req.file), `${code}\n`);
  } catch {
    return {
      applied: false,
      note: `expert fix could not be written to ${req.file}`,
    };
  }

  return {
    applied: true,
    file: req.file,
    note: `expert model repaired ${req.file}`,
  };
}

/** A file path parsed out of an error message, or undefined. Type-aware-lint names
 *  the file in text (e.g. "views/Issues/index.tsx:215 …") but doesn't populate the
 *  error's `.file`, so the expert would otherwise have nothing to hand over. */
function fileInMessage(message: string): string | undefined {
  const m = /\b([\w/.-]+\.[cm]?[jt]sx?)\b/u.exec(message);

  return m?.[1];
}

/**
 * Best-effort workspace-relative file for the stuck error — the target the expert
 * repairs. Prefers a populated `.file`, else a path parsed from the error MESSAGES.
 * Tries each candidate as-is and `src/`-prefixed (messages often drop the `src/`),
 * and absolute→relative, returning the first that resolves to an EXISTING file.
 * Null when nothing resolves (→ the caller logs a visible skip). This is what lets
 * the expert fire on type-aware-lint failures, which killed a whole live run.
 */
export async function resolveStuckFile(
  cwd: string,
  errors: readonly { readonly file?: string; readonly message: string }[]
): Promise<string | null> {
  const raws = [
    ...errors.flatMap((e) => (e.file === undefined ? [] : [e.file])),
    ...errors.flatMap((e) => {
      const f = fileInMessage(e.message);

      return f === undefined ? [] : [f];
    }),
  ].map((raw) => (isAbsolute(raw) ? relative(cwd, raw) : raw));

  // Exact location: as-is, or under src/ (messages often drop the prefix).
  for (const rel of raws) {
    for (const candidate of [rel, join("src", rel)]) {
      if (await Bun.file(join(cwd, candidate)).exists()) {
        return candidate;
      }
    }
  }

  // Basename only (e.g. stub-check names "dashboard.tsx" with no directory): find
  // it anywhere under src/ — routes/, views/, components/, wherever it lives. Guard
  // on src/ existing so a non-web build (no src/) resolves to null, not a throw.
  const srcDir = join(cwd, "src");
  const hasSrc = await stat(srcDir)
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (hasSrc) {
    for (const rel of raws) {
      const base = rel.split("/").at(-1);

      if (base === undefined || base.length === 0) {
        continue;
      }

      for await (const match of new Bun.Glob(`**/${base}`).scan({
        cwd: srcDir,
      })) {
        return join("src", match);
      }
    }
  }

  return null;
}

/** Wire config for the expert entry (key resolved at use time). Mirrors the small
 *  local builder in image-tools so this loop-layer module needn't import the CLI. */
function entryConfig(entry: IModelEntry): IOpenAICompatibleConfig {
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

/** The real expert ask backed by the configured `capabilities.expert` model, or
 *  null when the handoff is not explicitly enabled or no expert is configured (→ the
 *  run parks as before; fully backward compatible). Gated on `flags.expertRescue()`
 *  (opt-in) so a unit test or eval sweep that drives a run to a stall NEVER makes a
 *  live, paid API call — only real autonomous builders opt in. Resolution failures
 *  degrade to null (never break the loop). Tests that exercise the handoff inject
 *  their own ExpertAsk into `tryExpertRescue`, bypassing this gate entirely. */
export async function resolveExpertAsk(): Promise<ExpertAsk | null> {
  if (!flags.expertRescue()) {
    return null;
  }

  const resolved = await resolveCapabilityModel("expert").catch(() => null);

  if (resolved === null) {
    return null;
  }

  const provider = new OpenAICompatibleProvider(entryConfig(resolved.entry));

  return async (req: IExpertRequest): Promise<string | null> => {
    const res = await provider.complete([
      { role: "system", content: EXPERT_SYSTEM },
      { role: "user", content: buildFixPrompt(req) },
    ]);

    return res.content.length > 0 ? res.content : null;
  };
}
