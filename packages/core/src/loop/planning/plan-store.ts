import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { isRecord, isArray } from "../../lib/guards";
import type {
  IProductPlan,
  ISlice,
  IEntitySpec,
  IPlanSchema,
  IVerificationContract,
} from "./plan-types";

/**
 * Serialize a plan to YAML frontmatter + fenced JSON format.
 */
export function serializePlan<TUi>(
  plan: IProductPlan<TUi>,
  status: "draft" | "approved"
): string {
  const frontmatter = `---
status: ${status}
---`;

  const jsonBlock = `\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\``;

  return `${frontmatter}
${jsonBlock}`;
}

/**
 * Guard: validate a string is "draft" or "approved".
 */
function isValidStatus(value: unknown): value is "draft" | "approved" {
  return value === "draft" || value === "approved";
}

/**
 * Guard: validate a field shape within entity spec.
 */
function isField(value: unknown): value is {
  name: string;
  type: string;
  optional?: boolean;
} {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.name !== "string" || value.name === "") {
    return false;
  }

  if (typeof value.type !== "string" || value.type === "") {
    return false;
  }

  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    return false;
  }

  return true;
}

/**
 * Guard: validate an entity spec shape.
 */
function isEntitySpec(value: unknown): value is IEntitySpec {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || value.id === "") {
    return false;
  }

  if (typeof value.desc !== "string" || value.desc === "") {
    return false;
  }

  if (!isArray(value.fields)) {
    return false;
  }

  if (!value.fields.every(isField)) {
    return false;
  }

  if (!isArray(value.relationships)) {
    return false;
  }

  if (!value.relationships.every((x) => typeof x === "string")) {
    return false;
  }

  if (!isArray(value.rules)) {
    return false;
  }

  if (!value.rules.every((x) => typeof x === "string")) {
    return false;
  }

  return true;
}

/**
 * Guard: validate a verification contract shape.
 */
function isVerificationContract(
  value: unknown
): value is IVerificationContract {
  if (!isRecord(value)) {
    return false;
  }

  if (!isArray(value.mustRemainTrue)) {
    return false;
  }

  if (!value.mustRemainTrue.every((x) => typeof x === "string")) {
    return false;
  }

  if (!isArray(value.mustNotHappen)) {
    return false;
  }

  if (value.mustNotHappen.length === 0) {
    return false;
  }

  if (!value.mustNotHappen.every((x) => typeof x === "string")) {
    return false;
  }

  if (
    typeof value.acceptanceCheck !== "string" ||
    value.acceptanceCheck === ""
  ) {
    return false;
  }

  return true;
}

/**
 * Guard: validate a slice shape. Generic over the UI-intent type — the caller injects `validateUi`
 * (the stack adapter's `IPlanSchema.validateUi`), so core never names a concrete web UI shape.
 */
function isSlice<TUi>(
  value: unknown,
  validateUi: (v: unknown) => v is TUi
): value is ISlice<TUi> {
  if (!isRecord(value)) {
    return false;
  }

  if (!isEntitySpec(value.entity)) {
    return false;
  }

  if (!validateUi(value.ui)) {
    return false;
  }

  if (!isVerificationContract(value.verification)) {
    return false;
  }

  return true;
}

/**
 * Guard: validate a product plan shape. Core validates the SPINE (product + each slice's entity +
 * verification); the slice `ui` is validated by the injected `validateUi`, and any cross-slice rule
 * (e.g. BoringStack's "≤1 home") by the optional `extraCheck` — both supplied by the stack's
 * `IPlanSchema`, so no web-specific rule lives in core.
 */
export function isProductPlan<TUi>(
  value: unknown,
  validateUi: (v: unknown) => v is TUi,
  extraCheck?: (plan: IProductPlan<TUi>) => boolean
): value is IProductPlan<TUi> {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.product !== "string" || value.product === "") {
    return false;
  }

  if (!isArray(value.slices)) {
    return false;
  }

  if (!value.slices.every((s) => isSlice(s, validateUi))) {
    return false;
  }

  // `value` is now shape-verified as IProductPlan<TUi>; the narrowing predicate lets us hand it to
  // the stack's cross-slice rule without a cast.
  const plan: IProductPlan<TUi> = {
    product: value.product,
    slices: value.slices.filter((s): s is ISlice<TUi> =>
      isSlice(s, validateUi)
    ),
  };

  if (extraCheck !== undefined && !extraCheck(plan)) {
    return false;
  }

  return true;
}

/**
 * Extract frontmatter YAML from text.
 * Returns { status, jsonStart } on success, null on failure.
 */
function extractFrontmatter(text: string): {
  status: unknown;
  jsonStart: number;
} | null {
  if (!text.startsWith("---")) {
    return null;
  }

  const endMatch = text.indexOf("\n---\n");

  if (endMatch === -1) {
    return null;
  }

  const frontmatterText = text.substring(3, endMatch).trim();
  const statusMatch = /^status:\s*(\w+)/.exec(frontmatterText);

  if (!statusMatch) {
    return null;
  }

  return {
    status: statusMatch[1],
    jsonStart: endMatch + 5,
  };
}

/**
 * Extract JSON from a fenced code block.
 */
function extractJsonBlock(text: string, startIndex: number): string | null {
  const blockStart = text.indexOf("```json", startIndex);

  if (blockStart === -1) {
    return null;
  }

  const contentStart = blockStart + 7;
  const blockEnd = text.indexOf("```", contentStart);

  if (blockEnd === -1) {
    return null;
  }

  return text.substring(contentStart, blockEnd).trim();
}

/**
 * Parse a serialized plan. Returns null if the artifact is malformed.
 * Reject-by-default: any shape mismatch returns null, never a partial plan.
 */
export function parsePlan<TUi>(
  text: string,
  schema: IPlanSchema<TUi>
): { plan: IProductPlan<TUi>; status: "draft" | "approved" } | null {
  const fmResult = extractFrontmatter(text);

  if (!fmResult) {
    return null;
  }

  if (!isValidStatus(fmResult.status)) {
    return null;
  }

  const jsonText = extractJsonBlock(text, fmResult.jsonStart);

  if (jsonText === null) {
    return null;
  }

  let plan: unknown;

  try {
    plan = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isProductPlan(plan, schema.validateUi, schema.extraCheck)) {
    return null;
  }

  return {
    plan,
    status: fmResult.status,
  };
}

/**
 * Write a plan to ${cwd}/.specs/next.md, creating .specs/ if needed.
 */
export async function writePlan<TUi>(
  cwd: string,
  plan: IProductPlan<TUi>,
  status: "draft" | "approved"
): Promise<void> {
  const specsDir = join(cwd, ".specs");

  await mkdir(specsDir, { recursive: true });
  const filePath = join(specsDir, "next.md");
  const content = serializePlan(plan, status);

  await writeFile(filePath, content, "utf-8");
}

/**
 * Read a plan from ${cwd}/.specs/next.md. Returns null if the file doesn't exist or is malformed.
 * `schema` (the stack's `IPlanSchema`) validates the slice `ui` at the parse boundary.
 */
export async function readPlan<TUi>(
  cwd: string,
  schema: IPlanSchema<TUi>
): Promise<{ plan: IProductPlan<TUi>; status: "draft" | "approved" } | null> {
  const filePath = join(cwd, ".specs", "next.md");

  try {
    const content = await Bun.file(filePath).text();

    return parsePlan(content, schema);
  } catch {
    return null;
  }
}

/**
 * Load an approved plan from ${cwd}/.specs/next.md.
 * Returns the plan only when status === "approved", else null.
 */
export async function loadApprovedPlan<TUi>(
  cwd: string,
  schema: IPlanSchema<TUi>
): Promise<IProductPlan<TUi> | null> {
  const result = await readPlan(cwd, schema);

  if (result === null) {
    return null;
  }

  if (result.status === "approved") {
    return result.plan;
  }

  return null;
}
