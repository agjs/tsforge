import { describe, expect, test } from "bun:test";
import { mergeAnswerValues } from "../src/scaffold/scaffold-command";

describe("mergeAnswerValues", () => {
  test("flag values override wizard values for the same key", () => {
    const merged = mergeAnswerValues(
      { WITH_OBSERVABILITY: "1", EMAIL_PROVIDER: "cloudflare" },
      { EMAIL_PROVIDER: "resend" }
    );

    expect(merged.WITH_OBSERVABILITY).toBe("1"); // wizard value kept
    expect(merged.EMAIL_PROVIDER).toBe("resend"); // flag override wins
  });

  test("keys present only in one source are preserved", () => {
    const merged = mergeAnswerValues({ WITH_BULLMQ: "0" }, { project: "acme" });

    expect(merged.WITH_BULLMQ).toBe("0");
    expect(merged.project).toBe("acme");
  });

  test("empty flag set leaves wizard values intact", () => {
    const merged = mergeAnswerValues({ STACK: "dev" }, {});

    expect(merged).toEqual({ STACK: "dev" });
  });
});
