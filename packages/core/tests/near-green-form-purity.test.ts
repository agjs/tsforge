import { describe, expect, test } from "bun:test";
import {
  FORM_PURITY_ROLLBACK_RECIPE,
  checkpointLooksLikeFormTyping,
  formPurityRollbackAppendix,
  sprayLooksLikePurityUnmask,
} from "../src/loop/near-green-form-purity";
import type { IErrorItem } from "../src/validate/validate.types";

function err(partial: {
  message: string;
  rule?: string;
  key?: string;
}): IErrorItem {
  return {
    key: partial.key ?? partial.message,
    message: partial.message,
    ...(partial.rule === undefined ? {} : { rule: partial.rule }),
  };
}

describe("near-green Form+purity appendix", () => {
  test("checkpointLooksLikeFormTyping matches FieldValues messages", () => {
    expect(
      checkpointLooksLikeFormTyping([
        err({
          message:
            "Type 'UseFormReturn<FieldValues>' is not assignable to parameter",
        }),
      ])
    ).toBe(true);
    expect(
      checkpointLooksLikeFormTyping([
        err({ message: "Property 'x' does not exist on type 'Y'" }),
      ])
    ).toBe(false);
  });

  test("sprayLooksLikePurityUnmask needs majority purity hits", () => {
    expect(
      sprayLooksLikePurityUnmask([
        err({
          rule: "component-file-purity",
          message: "inlineConstant",
        }),
        err({
          rule: "component-file-purity",
          message: "inlineType",
        }),
        err({ message: "unrelated tsc" }),
      ])
    ).toBe(true);
    expect(
      sprayLooksLikePurityUnmask([
        err({ rule: "component-file-purity", message: "inlineConstant" }),
        err({ message: "a" }),
        err({ message: "b" }),
      ])
    ).toBe(false);
  });

  test("appendix only when Form checkpoint + purity spray", () => {
    const formCp = [
      err({
        message: "UseFormReturn<FieldValues> is not assignable",
      }),
    ];
    const puritySpray = [
      err({
        rule: "component-file-purity",
        message: "Move constant out of component file",
      }),
    ];

    expect(formPurityRollbackAppendix(formCp, puritySpray)).toContain(
      FORM_PURITY_ROLLBACK_RECIPE.slice(0, 40)
    );
    expect(formPurityRollbackAppendix(formCp, [])).toBe("");
    expect(
      formPurityRollbackAppendix([err({ message: "unrelated" })], puritySpray)
    ).toBe("");
  });
});
