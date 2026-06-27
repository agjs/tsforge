import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Session, type ILoopEvent } from "../../src/loop";
import {
  scriptedModel,
  type IScriptedModel,
  type ScriptedTurn,
} from "./scripted-model";

export interface IRunScriptedSession {
  /** The user's first message (the task). */
  task: string;
  /** The model's scripted turns. */
  turns: readonly ScriptedTurn[];
  /** Editable scope (paths under cwd). Omit ⇒ whole temp dir is editable. */
  files?: string[];
  /** Gate command run when a mutating turn ends (e.g. `"true"`, `"test -f ok"`). */
  accept?: string;
  /** Auto-fix command run before re-validating. */
  fix?: string;
  /** Read-only context files. */
  context?: string[];
  /** Files to pre-create in the temp cwd before the session runs (path → text). */
  seed?: Record<string, string>;
  /** Per-send turn cap. */
  maxTurns?: number;
}

export interface IScriptedSessionResult {
  status: string;
  turns: number;
  events: ILoopEvent[];
  model: IScriptedModel;
  cwd: string;
  /** Events of a given kind, in order. */
  eventsOfKind(kind: string): ILoopEvent[];
  /** Whether any event of a kind fired. */
  sawKind(kind: string): boolean;
  fileText(rel: string): string;
  fileExists(rel: string): boolean;
}

const createdDirs: string[] = [];

/** Remove every temp dir this harness created. Call from afterAll. */
export function cleanupScriptedSessions(): void {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedFiles(cwd: string, seed: Record<string, string>): void {
  for (const [rel, text] of Object.entries(seed)) {
    const abs = join(cwd, rel);

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

export async function runScriptedSession(
  opts: IRunScriptedSession
): Promise<IScriptedSessionResult> {
  const cwd = mkdtempSync(join(tmpdir(), "tsforge-e2e-"));

  createdDirs.push(cwd);

  if (opts.seed !== undefined) {
    seedFiles(cwd, opts.seed);
  }

  const events: ILoopEvent[] = [];
  const model = scriptedModel(opts.turns);

  const session = await Session.create({
    provider: model,
    cwd,
    files: opts.files ?? ["**/*"],
    accept: opts.accept,
    fix: opts.fix,
    context: opts.context,
    maxTurns: opts.maxTurns,
    report: (event: ILoopEvent) => {
      events.push(event);
    },
  });

  const result = await session.send(opts.task);

  return {
    status: result.status,
    turns: result.turns,
    events,
    model,
    cwd,
    eventsOfKind: (kind: string) => events.filter((e) => e.kind === kind),
    sawKind: (kind: string) => events.some((e) => e.kind === kind),
    fileText: (rel: string) => readFileSync(join(cwd, rel), "utf8"),
    fileExists: (rel: string) => existsSync(join(cwd, rel)),
  };
}
