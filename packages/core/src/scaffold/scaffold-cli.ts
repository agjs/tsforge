import {
  ARCHETYPES,
  isArchetype,
  type IArchetype,
  type IScaffoldAnswers,
} from "./scaffold.types";

/** Parsed non-interactive scaffold invocation (for the headless entry + eval
 *  driver). The answers feed `answersToPlan`/`runScaffold` exactly as the
 *  interactive wizard's would. */
export interface IScaffoldCliOptions {
  readonly answers: IScaffoldAnswers;
  readonly dest: string;
  readonly skipBoot: boolean;
  /** Override the manifest's defaultRef (`--ref`); "" = use the manifest. */
  readonly ref: string;
}

/**
 * Parse scaffold flags into answers. Pure (no I/O) so it's unit-testable:
 *   --archetype <astro|boringstack|phaser>   (default boringstack)
 *   --stack <dev|prod|smoke>          (default dev)
 *   --dest <dir>                      (required)
 *   --set KEY=VALUE                   (repeatable; single-valued answer)
 *   --multi KEY=a,b,c                 (repeatable; set-valued answer)
 *   --ref <git-ref>                   (override manifest defaultRef)
 *   --no-boot                         (skip the Docker boot)
 * Throws on an unknown archetype/stack, a missing dest, or a malformed --set/--multi.
 */
export function parseScaffoldArgs(
  argv: readonly string[]
): IScaffoldCliOptions {
  let archetype: IArchetype = "boringstack";
  let stack: IScaffoldAnswers["stack"] = "dev";
  let dest = "";
  let ref = "";
  let skipBoot = false;
  const values: Record<string, string | readonly string[]> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case "--archetype":
        archetype = parseArchetype(next(argv, i));
        i += 1;
        break;
      case "--stack":
        stack = parseStack(next(argv, i));
        i += 1;
        break;
      case "--dest":
        dest = next(argv, i);
        i += 1;
        break;
      case "--ref":
        ref = next(argv, i);
        i += 1;
        break;
      case "--no-boot":
        skipBoot = true;
        break;

      case "--set": {
        const [key, value] = splitPair(next(argv, i), "--set");

        values[key] = value;
        i += 1;
        break;
      }

      case "--multi": {
        const [key, value] = splitPair(next(argv, i), "--multi");

        values[key] = value.split(",").filter((s) => s.length > 0);
        i += 1;
        break;
      }

      default:
        throw new Error(`scaffold: unknown argument ${String(arg)}`);
    }
  }

  if (dest.length === 0) {
    throw new Error("scaffold: --dest <dir> is required");
  }

  return { answers: { archetype, stack, values }, dest, skipBoot, ref };
}

function next(argv: readonly string[], i: number): string {
  const v = argv[i + 1];

  if (v === undefined) {
    throw new Error(`scaffold: ${String(argv[i])} needs a value`);
  }

  return v;
}

function parseArchetype(v: string): IArchetype {
  if (isArchetype(v)) {
    return v;
  }

  throw new Error(
    `scaffold: unknown archetype ${v} (${ARCHETYPES.join(" | ")})`
  );
}

function parseStack(v: string): IScaffoldAnswers["stack"] {
  if (v !== "dev" && v !== "prod" && v !== "smoke") {
    throw new Error(`scaffold: unknown stack ${v} (dev | prod | smoke)`);
  }

  return v;
}

function splitPair(raw: string, flag: string): readonly [string, string] {
  const eq = raw.indexOf("=");

  if (eq <= 0) {
    throw new Error(`scaffold: ${flag} expects KEY=VALUE, got ${raw}`);
  }

  return [raw.slice(0, eq), raw.slice(eq + 1)];
}
