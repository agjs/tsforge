import { test, expect } from "bun:test";
import {
  PROPOSAL_SCHEMA,
  PROPOSAL_SCHEMA_NAME,
} from "../src/self-harness/proposal-schema";
import { emptyOverlay, parseOverlay } from "../src/self-harness";
import { PROMPT_BLOCK_NAMES } from "../src/self-harness/self-harness.types";

/** The patch sub-schema, which is what constrains the decode. */
const patchSchema = PROPOSAL_SCHEMA.properties.patch;

test("the schema covers exactly the editable surfaces — no more, no fewer", () => {
  // Drift in either direction is a real failure: a surface missing here can
  // never be proposed (the decode forbids it), and a surface here that the
  // overlay does not have produces candidates that always validate to nothing.
  const surfaces = Object.keys(patchSchema.properties).sort();
  const overlaySurfaces = Object.keys(emptyOverlay())
    .filter((k) => k !== "version")
    .sort();

  expect(surfaces).toEqual(overlaySurfaces);
});

test("the surface enum names the same set", () => {
  const named = PROPOSAL_SCHEMA.properties.surface.enum.map((s: string) => s);

  expect(named.sort()).toEqual(Object.keys(patchSchema.properties).sort());
});

test("prompt blocks are pinned to the four named anchors", () => {
  // The proposer must not be able to invent a block name: an unknown anchor
  // would validate away silently and burn a candidate slot.
  expect(Object.keys(patchSchema.properties.promptBlocks.properties)).toEqual([
    ...PROMPT_BLOCK_NAMES,
  ]);
  expect(patchSchema.properties.promptBlocks.additionalProperties).toBe(false);
});

test("no surface is required — a candidate must be able to touch just one", () => {
  // The paper requires minimality within each proposal. A `required` list here
  // would force every candidate to edit all four surfaces at once.
  expect(patchSchema).not.toHaveProperty("required");
});

test("the audit record the paper requires is mandatory", () => {
  expect([...PROPOSAL_SCHEMA.required].sort()).toEqual([
    "expectedEffect",
    "patch",
    "risks",
    "surface",
    "targetPattern",
  ]);
});

test("a patch shaped by the schema survives the real overlay validator", () => {
  // The schema only shapes the decode; parseOverlay remains the authority. A
  // response that satisfies the schema must not then be thrown away.
  const shaped = {
    ttsrRules: [
      {
        name: "test-sibling-first",
        condition: ["export function"],
        scope: "tool-args",
        guidance: "Create the test sibling before editing the source again.",
        repeatMode: "cooldown",
        repeatGap: 3,
      },
    ],
    promptBlocks: { execution: { mode: "append", text: "Check the gate." } },
    procedureCards: { TS2307: { procedure: "Add the missing import." } },
    agentSpecOverrides: [{ id: "expert", maxTurns: 12 }],
  };

  const parsed = parseOverlay(shaped);

  expect(parsed).not.toBeNull();
  expect(parsed?.ttsrRules).toHaveLength(1);
  expect(parsed?.promptBlocks.execution?.text).toBe("Check the gate.");
  expect(parsed?.procedureCards.TS2307?.procedure).toBe(
    "Add the missing import."
  );
  expect(parsed?.agentSpecOverrides[0]?.id).toBe("expert");
});

test("the schema is named, so a server can report which one it enforced", () => {
  expect(PROPOSAL_SCHEMA_NAME).toBe("harness_proposal");
});
