import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import {
  conventionGuide,
  conventionTopics,
  isConventionTopic,
  topicForRule,
  unseenGuidesForErrors,
} from "../src/loop/conventions";
import { PULL_CONVENTIONS_TOOL } from "../src/agent/agent.constants";
import { injectFeedback, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import type { IErrorItem } from "../src/validate";
import { commandGate } from "../src/gate/gate-runner";

describe("convention registry", () => {
  test("every topic has a non-empty guide", () => {
    for (const topic of conventionTopics()) {
      expect(conventionGuide(topic).length).toBeGreaterThan(40);
    }
  });

  test("the no-casts guide teaches a type guard, never a cast", () => {
    const g = conventionGuide("no-casts");

    expect(g).toContain("TYPE GUARD");
    expect(g).toContain("v is St");
  });

  test("component-anatomy points components to src/features (the real boringstack layout)", () => {
    const g = conventionGuide("component-anatomy");

    expect(g).toContain("src/features/<feature>/components/");
    // The dead UI-only-React `src/views` layout must be gone.
    expect(g).not.toContain("src/views/");
    // The FULL required sibling set incl the easily-forgotten .stories.tsx (build9 arch wall).
    expect(g).toContain(".stories.tsx");
    expect(g).toContain("missing required siblings");
  });

  test("jsx guide gives the exact jsx-no-bind fix for list-row handlers (build7 parking residual)", () => {
    const g = conventionGuide("jsx");

    expect(g).toContain("react/jsx-no-bind");
    expect(g).toContain("STABLE reference");
    // Both an inline arrow AND a body-defined arrow are rejected — the model kept doing the latter.
    expect(g).toContain("recreated every render");
    expect(g).toContain("useCallback");
    expect(g).toContain("onEdit(id)");
  });

  test("api-service guide teaches the audit-event idiom on mutating methods (build6 hard-gate residual)", () => {
    const g = conventionGuide("api-service");

    expect(g).toContain("auditLogService.record");
    expect(g).toContain("AUDIT_ACTIONS");
    expect(g).toContain("audit event");
    // Mutations only; reads exempt; throw ApiError (not error envelopes).
    expect(g).toContain("create/update/delete");
    expect(g).toContain("ApiError");
    // response: schema is for the body TYPE, define it like AccountResponse (no headers)…
    expect(g).toContain("response:");
    expect(g).toContain("AccountResponse");
    // …but build15 proved Readable<SuccessResponse> is NOT a route fix — the guide must say so
    // (Elysia always emits multi media types; the consumer handles it via data?.data).
    expect(g).toContain("Readable<SuccessResponse");
    expect(g).toContain("does NOT collapse the media types");
    expect(g).toContain("data?.data");
  });

  test("i18n guide bans pre-declaring keys — the dominant near-green thrash (build11: 19× dead-key)", () => {
    const g = conventionGuide("i18n");

    // The CAUSE: the model pre-declares locale keys it never references. The guide must forbid it
    // and pin the two-way rule so the model connects the gate error to the fix.
    expect(g).toContain("PRE-DECLARING");
    expect(g).toContain("i18n-locale-keys-used");
    expect(g).toContain("SAME change");
    // The verified wiring idiom (react-i18next, full dotted literal, both locales).
    expect(g).toContain("useTranslation");
    expect(g).toContain("react-i18next");
    expect(g).toContain("STRING LITERAL");
    expect(g).toContain("locales/en/common.json");
    expect(g).toContain("locales/de/common.json");
    // The fix MUST be the harness-sanctioned one — WIRE IT UP, never delete a session-authored
    // key (rule-docs.ts + i18n-guard + near-green completion-class all mandate clear-by-adding).
    // The guide must NOT offer deletion as an equal fix (that re-introduces the #49 churn).
    expect(g).toContain("WIRE IT UP");
    expect(g).toContain("Do NOT delete a key you authored");
    expect(g).toContain("VETOES");
    expect(g).not.toContain("EXACTLY ONE");
    // A dynamic template key bypasses the used→defined (static-translation-key-exists) check,
    // so the guide must forbid it and require a static literal per concrete case.
    expect(g).toContain("BYPASSES validation");
  });

  test("i18n is a first-class pullable topic — registry AND pull_conventions enum agree (no drift)", () => {
    // The three hand-maintained surfaces for a topic must all carry `i18n`, or the model
    // hits a live guide it can't `pull_conventions` for (enum reject) — the exact drift the
    // reviewers flagged. convention-index.test.ts locks the full enum↔topics parity; this pins
    // the NEW topic explicitly in its own change so the guard is visible beside the addition.
    expect(conventionTopics()).toContain("i18n");
    expect(isConventionTopic("i18n")).toBe(true);
    const enumTopics =
      PULL_CONVENTIONS_TOOL.function.parameters.properties.topic.enum;

    expect(enumTopics).toContain("i18n");
  });

  test("forms guide steers away from the invented FormEvent + deprecated z.string().email() (live-build residuals)", () => {
    const g = conventionGuide("forms");

    expect(g).toContain("zodResolver");
    expect(g).toContain("handleSubmit");
    // The model repeatedly invented React's FormEvent and used the deprecated Zod string email.
    expect(g).toContain("FormEvent");
    expect(g).toContain("z.email()");
    expect(g).toContain("z.string().email()");
    expect(g).toContain("BaseSyntheticEvent");
    // build8 park (#67): the rhf resolver input≠output type mismatch from .optional()/.default().
    expect(g).toContain("SubmitHandler");
    expect(g).toContain("defaultValues");
  });

  test("data-fetching guide states the apiClient pattern and forbids response.error", () => {
    const g = conventionGuide("data-fetching");

    expect(g).toContain("@/lib/api/client");
    expect(g).toContain("const { data }");
    expect(g).toContain("response.error");
    expect(g).toContain("throwOnError");
  });

  test("data-fetching guide pins the exact api-client path format + call shapes (build12 park cluster)", () => {
    const g = conventionGuide("data-fetching");

    // The path bug that sprayed build12: model used "/api/supplier" — must be "/api/v1/…".
    expect(g).toContain("/api/v1/");
    expect(g).toContain("PathsWithMethod");
    // Full method↔shape pairings (not loose fragments) — a fragment on the wrong method must fail.
    // COLLECTION root carries a TRAILING SLASH (build14: the model sprayed on POST /api/v1/supplier
    // for ~40 turns until it discovered the generated key is /api/v1/supplier/).
    expect(g).toContain('apiClient.POST("/api/v1/supplier/", { body: input })');
    expect(g).toContain(
      'apiClient.PATCH("/api/v1/supplier/{id}", { params: { path: { id } }, body: input })'
    );
    expect(g).toContain(
      'apiClient.DELETE("/api/v1/supplier/{id}", { params: { path: { id } } })'
    );
    // The trailing-slash rule is stated explicitly (collection root vs by-id).
    expect(g).toContain("TRAILING SLASH");
    expect(g).toContain('POST "/api/v1/<resource>/"');
    // Options are OPTIONAL and there is never a THIRD positional arg (the corrected contradiction).
    expect(g).toContain("options object is OPTIONAL");
    expect(g).toContain("NEVER a " + "third positional argument");
    expect(g).toContain("arity error");
    // generate:api is the WRONG lever for a consumer/usage error (model reran it 5×).
    expect(g).toContain("generate:api");
    expect(g).toContain("usage bug, not a stale-spec bug");
    // Readable<SuccessResponse> is UNIVERSAL + EXPECTED (build15) — consumed via data?.data,
    // NOT fixed on the route. The guide must teach the consumer unwrap + infer-not-annotate.
    expect(g).toContain("Readable<SuccessResponse");
    expect(g).toContain("data?.data");
    expect(g).toContain("EXPECTED and UNIVERSAL");
    expect(g).toContain("not assignable to Promise<IEntity>");
    // The UNIVERSAL fix is infer-don't-annotate; data?.data is SHAPE-CONDITIONAL (panel: not
    // every response is {data:…} — a raw object/array returns `data` directly), so the guide
    // must NOT categorically prescribe .data.
    expect(g).toContain("let TS INFER");
    expect(g).toContain("don't blindly add");
  });

  test("testing guide teaches the exact idioms the model kept failing (extension, hoisted mock, route tests, rules)", () => {
    const g = conventionGuide("testing");

    // The .test.ts vs .test.tsx decision + the never-both rule (the dual-extension churn).
    expect(g).toContain(".test.tsx");
    expect(g).toContain(".test.ts");
    expect(g).toContain("never both");
    // The api-client mock idiom the model reinvented 16× (getting `any`-typed data).
    expect(g).toContain("vi.hoisted");
    expect(g).toContain('vi.mock("@/lib/api/client"');
    expect(g).toContain("mockResolvedValueOnce");
    expect(g).toContain("keeps `data` typed");
    // Mock reset between tests (deepseek-flagged gap): the pass-alone-fail-in-suite trap.
    expect(g).toContain("mockReset");
    expect(g).toContain("fails in the suite");
    // The correct global reset is resetAllMocks (resets queued return values); clearAllMocks
    // only clears call history and would NOT prevent the leak — the guide must steer away from it.
    expect(g).toContain("resetAllMocks");
    expect(g).toContain("NOT `vi.clearAllMocks()`");
    // The API route test idiom from the shipped example.
    expect(g).toContain("createApp()");
    expect(g).toContain("app.handle");
    expect(g).toContain("loginCookie");
    // API runner is bun:test (not vitest) + the service-test smoke idiom (build4 residual:
    // 14 edits grinding a DB-hitting supplier.service.test.ts against Drizzle types).
    expect(g).toContain('from "bun:test"');
    expect(g).toContain("smoke");
    expect(g).toContain('expect(typeof myServiceFn).toBe("function")');
    // The enforced test rules, each named so the model connects error → fix.
    expect(g).toContain("no-focused-tests");
    expect(g).toContain("no-conditional-expect");
    expect(g).toContain("fake-timers-must-be-restored");
    // The auto-reformat re-read (the not-found edit-reject churn).
    expect(g).toContain("AUTO-FORMATS");
  });
});

describe("topicForRule (testing)", () => {
  test("EVERY testing rule maps to the testing topic so its gate error pushes the guide", () => {
    // Lock all six — a typo in any would silently disable the reactive PUSH for that error.
    for (const rule of [
      "test-sibling-required",
      "test-file-mirrors-source",
      "no-focused-tests",
      "no-conditional-expect",
      "no-real-network-in-unit-tests",
      "fake-timers-must-be-restored",
    ]) {
      expect(topicForRule(rule)).toBe("testing");
    }
  });
});

describe("topicForRule", () => {
  test("maps enforced rule ids (bare and plugin-prefixed) to their topic", () => {
    expect(topicForRule("component-file-purity")).toBe("file-layout");
    expect(topicForRule("tsforge/no-jsx-computation")).toBe("jsx");
    expect(topicForRule("no-restricted-syntax")).toBe("no-casts");
    expect(topicForRule("component-folder-structure")).toBe(
      "component-anatomy"
    );
    // BOTH i18n directions must PUSH the i18n guide: the dead-key trap (defined→used, build11)
    // AND a t() whose key isn't defined (used→defined, plugin-prefixed in the wild).
    expect(topicForRule("i18n-locale-keys-used")).toBe("i18n");
    expect(topicForRule("static-translation-key-exists")).toBe("i18n");
    expect(topicForRule("i18n-keys/static-translation-key-exists")).toBe(
      "i18n"
    );
  });

  test("an unknown rule maps to nothing", () => {
    expect(topicForRule("some-random-rule")).toBeNull();
  });
});

describe("unseenGuidesForErrors (the PUSH dedup)", () => {
  test("returns the guide the FIRST time a rule is hit, then never again", () => {
    const seen = new Set<string>();
    const errors = [{ rule: "tsforge/component-file-purity" }];

    const first = unseenGuidesForErrors(errors, seen);

    expect(first).toHaveLength(1);
    expect(first[0]).toContain("FILE PURITY");

    // Same rule next cycle → already pushed → nothing (no wall of repeats).
    expect(unseenGuidesForErrors(errors, seen)).toHaveLength(0);
  });

  test("one guide per TOPIC even across many errors of that topic", () => {
    const seen = new Set<string>();
    const errors = [
      { rule: "component-folder-structure" },
      { rule: "one-component-per-file" }, // same topic (component-anatomy)
      { rule: "no-restricted-syntax" }, // different topic (no-casts)
    ];

    const guides = unseenGuidesForErrors(errors, seen);

    expect(guides).toHaveLength(2); // component-anatomy + no-casts, not 3
  });

  test("errors with no rule, or unknown rules, contribute nothing", () => {
    const seen = new Set<string>();

    expect(
      unseenGuidesForErrors([{ rule: undefined }, { rule: "unknown" }], seen)
    ).toEqual([]);
  });
});

describe("convention PUSH delivery (the guide actually reaches the model + is observable)", () => {
  function makeCtx(events: ILoopEvent[]): ILoopCtx {
    return {
      task: {
        id: "t",
        intent: "build",
        accept: "true",
        files: [],
        context: [],
      },
      cwd: tmpdir(),
      tsService: null,
      report: (e) => {
        events.push(e);
      },
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(
          {
            id: "t",
            intent: "build",
            accept: "true",
            files: [],
            context: [],
          },
          undefined
        ),
      },
    };
  }

  function freshState(): ILoopState {
    return {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: Number.POSITIVE_INFINITY,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: -1,
      edits: 0,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      // These tests cover the boringstack convention PUSH — the backend that ships
      // the library turns it on. A plain build (conventionsEnabled unset) never pushes.
      conventionsEnabled: true,
    };
  }

  const asCastError: IErrorItem = {
    key: "src/x.tsx:1:no-restricted-syntax",
    file: "src/x.tsx",
    rule: "no-restricted-syntax", // → no-casts guide
    message: "L1: No `as` type casts (no-restricted-syntax)",
  };

  test("a gate error maps to a guide that lands in the message SENT to the model", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    await injectFeedback(ctx, state, [asCastError], [], []);

    // The guide is in the actual user message the model will receive next.
    const sent = ctx.messages.at(-1)?.content ?? "";

    expect(sent).toContain("HOW TO WRITE THIS RIGHT (boringstack)");
    expect(sent).toContain("TYPE GUARD"); // the no-casts guide's teaching
    // …and the push is OBSERVABLE (was silent — you couldn't tell it fired).
    expect(
      events.some((e) => e.kind === "tool" && e.message.includes("📐 pushed"))
    ).toBe(true);
  });

  test("the same topic is pushed only ONCE per run (deduped, not a wall)", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    await injectFeedback(ctx, state, [asCastError], [], []);
    await injectFeedback(ctx, state, [asCastError], [], []);

    const pushes = events.filter(
      (e) => e.kind === "tool" && e.message.includes("📐 pushed")
    );

    expect(pushes).toHaveLength(1); // second cycle: already taught, no re-push
    expect(ctx.messages.at(-1)?.content ?? "").not.toContain(
      "HOW TO WRITE THIS RIGHT"
    );
  });

  test("a plain build (conventionsEnabled off) is NEVER pushed boringstack how-to", async () => {
    // Decoupling guarantee: a backend without a convention library gets the gate
    // error + rule docs, but no boringstack-flavored guide injected. Symmetric with
    // pull_conventions being withheld unless the backend opts in.
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = { ...freshState(), conventionsEnabled: false };

    await injectFeedback(ctx, state, [asCastError], [], []);

    expect(ctx.messages.at(-1)?.content ?? "").not.toContain(
      "HOW TO WRITE THIS RIGHT"
    );
    expect(
      events.some((e) => e.kind === "tool" && e.message.includes("📐 pushed"))
    ).toBe(false);
  });
});
