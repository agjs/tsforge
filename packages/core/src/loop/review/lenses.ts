import type { ILens } from "./review.types";

/**
 * The built-in senior-review rubric. This is the knowledge that makes `tsforge
 * review` more than "ask the model to review a diff": each lens tells the model
 * exactly what to focus on, with the questions a senior reviewer actually asks
 * and a concrete example of the kind of bug it catches. Fed to the model so a
 * SMALL local model reviews like a senior engineer.
 *
 * Deliberately scoped to FUNCTIONAL review (logic, behaviour, regressions) — the
 * gate (tsc + rule packs + meta-rules) already covers types, structure, style.
 * Fixed in the harness for now; structured so it can become project-configurable
 * later (like rule packs).
 */
export const LENSES: readonly ILens[] = [
  {
    id: "correctness",
    title: "Logic correctness",
    focus:
      "Does the code actually do what the surrounding names, comments, and call sites imply it should?",
    questions: [
      "Are any conditions inverted, or operators wrong (< vs <=, && vs ||, + vs -)?",
      "Off-by-one in loops/indexing/slicing?",
      "Does every branch return/assign the value it's supposed to?",
    ],
    example:
      "A `getDiscount` that returns the price instead of the discount because the subtraction is reversed.",
  },
  {
    id: "regressions",
    title: "Regressions & contract changes",
    focus:
      "Does this change break existing callers or alter behaviour they depend on?",
    questions: [
      "Did a function signature, return shape, thrown error, or default value change?",
      "Will an existing caller now get a different result for the same input?",
      "Was a previously handled case silently dropped?",
    ],
    example:
      "Changing a function to return `null` instead of `[]`, so every caller that does `.map` now throws.",
  },
  {
    id: "edge-cases",
    title: "Edge cases & error paths",
    focus: "What happens at the boundaries and on the unhappy path?",
    questions: [
      "Empty / null / undefined / zero / negative / very large inputs?",
      "Are errors and rejected promises handled, or do they escape?",
      "Is there an unawaited async call, or a missing await before using a result?",
    ],
    example:
      "Splitting a string and indexing `[1]` without checking the split produced two parts.",
  },
  {
    id: "business-logic",
    title: "Business rules",
    focus:
      "Does the change honour the domain rules the code is responsible for?",
    questions: [
      "Money: integer-cents vs float, correct rounding, currency mixing?",
      "Auth/permissions: is every privileged path actually gated?",
      "State machines: are invalid transitions prevented; are invariants kept?",
    ],
    example:
      "An order total computed with floating-point dollars, losing a cent on rounding.",
  },
  {
    id: "data-concurrency",
    title: "Data & concurrency",
    focus: "Can two things racing, or a partial failure, corrupt state?",
    questions: [
      "Read-modify-write without atomicity; check-then-act races?",
      "A multi-step write that can fail halfway and leave inconsistent data?",
      "Shared mutable state touched from concurrent handlers?",
    ],
    example:
      "Incrementing a counter via read → +1 → write, losing updates under concurrency.",
  },
  {
    id: "api-contract",
    title: "API & external contracts",
    focus:
      "Does the change keep faith with what consumers and external systems expect?",
    questions: [
      "Breaking an HTTP route's response shape, status code, or required field?",
      "Changing serialized/persisted formats without migration?",
      "Sending more/less data than the consumer expects (over- or under-fetching)?",
    ],
    example:
      "Renaming a JSON response field, breaking every client that reads the old name.",
  },
];

/** Compact rubric text for a single lens, injected into the find prompt. */
export function lensRubric(lens: ILens): string {
  const qs = lens.questions.map((q) => `  - ${q}`).join("\n");

  return `### ${lens.title} (lens id: ${lens.id})\n${lens.focus}\nAsk:\n${qs}\nExample bug: ${lens.example}`;
}
