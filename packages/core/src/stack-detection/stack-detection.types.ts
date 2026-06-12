/** A detected technology stack profile that determines which rule packs to enable. */
export interface IStackProfile {
  /** Friendly stack name: "react", "node-backend", "generic", or combined like "react+drizzle". */
  readonly name: string;

  /** Enabled rule pack IDs, always includes "generic-ts" and other always-on packs. */
  readonly packs: readonly string[];

  /** How confident the detection is: "certain" (deps found), "likely" (files exist), "guess" (fallback). */
  readonly confidence: "certain" | "likely" | "guess";

  /** Human-readable reason for the profile, e.g., "react + drizzle-orm in package.json". */
  readonly reason: string;
}

/** Metadata for a rule pack that determines when it should be enabled. */
export interface IRulePackDescriptor {
  /** Unique identifier for the pack, used in enabled lists. */
  readonly id: string;

  /** Human-readable label. */
  readonly label: string;

  /** Short description of what the pack covers. */
  readonly description: string;

  /** Category for UI/filtering: "language" | "framework" | "library" | "infra" | "testing". */
  readonly category: "language" | "framework" | "library" | "infra" | "testing";

  /** Conditions under which this pack should be enabled. */
  readonly appliesWhen: {
    /** Enable if ANY of these deps (in dependencies or devDependencies) are present. */
    readonly anyDeps?: readonly string[];

    /** Enable only if ALL of these deps are present. */
    readonly allDeps?: readonly string[];

    /** Enable if any of these file paths/globs exist. */
    readonly files?: readonly string[];

    /** Enable this pack unconditionally (used for always-on packs like generic-ts). */
    readonly always?: boolean;
  };

  /** Short guidance text injected into system prompt when pack is active (populated in later tasks). */
  readonly guidance?: string;
}
