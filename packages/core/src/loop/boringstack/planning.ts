import { readFile } from "node:fs/promises";
import type { IPlanConstraints } from "../planning/plan-types";
import type { IStackAdapter } from "../planning/stack-adapter";
import { readScaffoldArchetype } from "../../scaffold/receipt";
import { boringstackPlanSchemaErased } from "./plan-extension";

/** STACK-SPECIFIC planner guidance for BoringStack (kept OUT of the generic
 *  planner). Appended to the system prompt only for a BoringStack project. The
 *  starter ships auth, so a slice that rebuilds it duplicates the built-in surface
 *  and traps the build (its locale keys/routes never wire up → the gate loops on
 *  "unused" keys). */
export const BORINGSTACK_PLANNER_GUIDANCE = `This build targets the BoringStack starter, which ALREADY PROVIDES authentication out of the box: sign-up, log-in, log-out, the users table, sessions, and per-user ownership all exist. Do NOT propose a slice that REBUILDS that auth surface — no User, Auth, Login, SignUp, or Logout entity. Treat "a user" as an existing actor your entities belong to (via a relationship like "belongs to a User"), never an entity to build. But DO propose the product's own domain entities normally — including any that happen to share a word with an auth concept when they are genuinely part of the product domain (a billing Account, a therapy Session, a social Profile are real features, not the auth surface).`;

/** PURE auth/identity terms BoringStack already ships. DELIBERATELY NARROW: only
 *  terms that are ~never a legitimate standalone product-domain entity in an
 *  auth-shipping stack. Ambiguous nouns that ARE real domains elsewhere — Account
 *  (billing), Session (therapy), Profile (social), Credential (certification) — are
 *  NOT reserved, so those products keep their features. Singular + plural;
 *  compared lowercased. */
export const BORINGSTACK_RESERVED_ENTITY_IDS: ReadonlySet<string> = new Set([
  "user",
  "users",
  "auth",
  "authentication",
  "login",
  "logins",
  "signin",
  "signins",
  "signup",
  "signups",
  "logout",
  "logouts",
]);

/**
 * Detect a BoringStack project by its AUTHORITATIVE scaffold receipt
 * (`.tsforge/scaffold.json` archetype === "boringstack"), NOT by a directory
 * topology a generic monorepo could share (apps/api + apps/ui + infra/compose is
 * not proof). Only a tsforge-scaffolded BoringStack writes that receipt, so this
 * has no false positives. Used for BOTH the planning interception AND the planner
 * constraints — one signal, so there is no gap where a project is planned as
 * BoringStack but not given the reserved-slice rule. `read` is injectable for tests.
 */
export async function isBoringstackProject(
  dir: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<boolean> {
  return (await readScaffoldArchetype(dir, read)) === "boringstack";
}

/**
 * The planner constraints for a BoringStack project: the auth guidance + reserved
 * pure-auth entity stripping. `onStripped` is REQUIRED — the drop is always
 * surfaced (no silent truncation); the caller wires it to its own output sink.
 */
export function boringstackPlanConstraints(
  onStripped: (droppedEntityIds: readonly string[]) => void
): IPlanConstraints {
  return {
    guidance: BORINGSTACK_PLANNER_GUIDANCE,
    reservedEntities: BORINGSTACK_RESERVED_ENTITY_IDS,
    onStripped,
  };
}

/**
 * The BoringStack stack adapter as the generic greenfield flow sees it (`IStackAdapter`).
 * This is the single registration point the composition root (the CLI) imports; the core
 * planning logic depends only on the interface, never on `isBoringstackProject` /
 * `boringstackPlanConstraints` directly.
 */
export const boringstackStackAdapter: IStackAdapter = {
  id: "boringstack",
  detect: (dir) => isBoringstackProject(dir),
  planConstraints: boringstackPlanConstraints,
  planSchema: boringstackPlanSchemaErased,
};
