/**
 * Types for the generated architecture map (`packages/core/ARCHITECTURE.md`).
 *
 * The map answers "what systems exist and how do they couple" from source, so the
 * facts cannot drift from the code the way a hand-written layout table does.
 */

/** Whether a subsystem runs on every build or only under an opt-in feature. */
export type SubsystemTier = "core" | "optional";

/** Hand-written facts about a subsystem. A purpose cannot be derived from source. */
export interface ISubsystemEntry {
  /** One line: what this subsystem is for. Present tense, no trailing period. */
  readonly purpose: string;

  /** `core` = on the hot path of an ordinary build; `optional` = feature-gated. */
  readonly tier: SubsystemTier;
}

/** A subsystem: one top-level directory under `src/`, plus the loose root files. */
export interface ISubsystem {
  /** Directory name under `src/`, or `(root)` for the loose `src/*.ts` files. */
  readonly id: string;

  /** Purpose from the registry. */
  readonly purpose: string;

  /** Tier from the registry. */
  readonly tier: SubsystemTier;

  /** Number of `.ts` files owned, counting nested directories. */
  readonly files: number;

  /** Total lines across those files. */
  readonly lines: number;

  /** How many other subsystems import this one. */
  readonly fanIn: number;

  /** How many other subsystems this one imports. */
  readonly fanOut: number;
}

/** One directed subsystem-to-subsystem coupling, with a witness import to prove it. */
export interface IEdge {
  /** Importing subsystem id. */
  readonly from: string;

  /** Imported subsystem id. */
  readonly to: string;

  /** A real import that creates this edge, as `path/to/file.ts:12`. */
  readonly witness: string;

  /** The specifier that witness line imports, e.g. `../self-harness/overlay`. */
  readonly specifier: string;
}

/**
 * A mutual dependency between two subsystems.
 *
 * Modelled as two named edges rather than an array: a mutual pair has exactly two
 * directions, and naming them means no caller has to index into a list and prove to
 * the compiler that the elements exist.
 */
export interface ICycle {
  /** The alphabetically first subsystem in the pair. */
  readonly a: string;

  /** The other subsystem. */
  readonly b: string;

  /** The import that makes `a` depend on `b`. */
  readonly aToB: IEdge;

  /** The import that makes `b` depend on `a`. */
  readonly bToA: IEdge;
}

/**
 * A relative import that resolves outside `src/`.
 *
 * Worth surfacing rather than dropping: `src/` reaching into `scripts/` inverts the
 * repo's "scripts orchestrate, `src/` decides" rule, and nothing else reports it.
 */
export interface IExternalImport {
  /** Importing subsystem id. */
  readonly from: string;

  /** Where the import sits, as `path/to/file.ts:11`. */
  readonly witness: string;

  /** Path of the imported file, relative to the package root. */
  readonly target: string;
}

/** A user-reachable entry point: a CLI mode function dispatched from `main()`. */
export interface IEntryPoint {
  /** Function name as written, e.g. `reviewMode`. */
  readonly fn: string;

  /** Where it is defined, as `path/to/file.ts:181`. */
  readonly at: string;
}

/** An injected interface that lets an adapter plug into the core loop. */
export interface ISeam {
  /** Interface name, e.g. `IStackAdapter`. */
  readonly name: string;

  /** Where the interface is declared, as `path/to/file.ts:14`. */
  readonly declaredAt: string;

  /** Subsystem-relative files that implement or construct it. */
  readonly implementors: readonly string[];
}

/** The whole derived map, ready to serialize. */
export interface IArchitecture {
  /** Every subsystem, sorted by lines descending. */
  readonly subsystems: readonly ISubsystem[];

  /** Every cross-subsystem edge, deduplicated by `from`/`to`. */
  readonly edges: readonly IEdge[];

  /** Detected cycles, shortest first. */
  readonly cycles: readonly ICycle[];

  /** CLI mode functions reachable from `main()`. */
  readonly entryPoints: readonly IEntryPoint[];

  /** Adapter seams and who implements them. */
  readonly seams: readonly ISeam[];

  /** Relative imports that leave `src/`. Empty is the healthy state. */
  readonly externals: readonly IExternalImport[];

  /** Total `.ts` files scanned. */
  readonly totalFiles: number;

  /** Total lines scanned. */
  readonly totalLines: number;
}
