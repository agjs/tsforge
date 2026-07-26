import { describe, it, expect } from "bun:test";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { ISlice } from "../src/loop/planning/plan-types";
import { refinePrompt } from "../src/loop/boringstack/refine-prompt";

describe("refinePrompt", () => {
  it("contains the resource id", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record with line items and payment tracking",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("Invoice");
  });

  it("prescribes Elysia TypeBox for API schemas, never Zod (the boundary the scaffold uses)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // API schemas use Elysia TypeBox — the scaffold's *.schemas.ts is `import { t } from "elysia"`.
    expect(prompt).toContain("TypeBox");
    expect(prompt).toContain("elysia");
    // The API layer must list the routes file (was omitted).
    expect(prompt).toContain("invoice.routes.ts");
    // Must NOT tell the model to use Zod for API request/response schemas.
    expect(prompt).not.toContain("Zod schemas for request/response");
  });

  it("demands a REAL CRUD UI (mutations + list + form + delete), not a hollow list-only page", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // The three real mutations must be named (the stub gap).
    expect(prompt).toContain("useCreateInvoice");
    expect(prompt).toContain("useUpdateInvoice");
    expect(prompt).toContain("useDeleteInvoice");
    // A hollow list-only page is explicitly rejected.
    expect(prompt).toContain("INCOMPLETE feature");
    // Form + delete confirmation are required.
    expect(prompt).toContain("Create/Edit form");
    expect(prompt).toContain("confirmDelete");
    // The old vague phrasing is gone (would let the model ship anything).
    expect(prompt).not.toContain("The complete React feature slice for");
    // The API must expose the full CRUD the UI mutations target (no contradiction).
    expect(prompt).toContain("PATCH /:id");
    expect(prompt).toContain("DELETE /:id");
    // User-scoped, mirroring the scaffold convention (extend, don't rename).
    expect(prompt).toContain("listForUser");
    expect(prompt).toContain("getForUser");
    // SECURITY: get/update/delete must filter by the authenticated userId.
    expect(prompt.toLowerCase()).toContain("privilege escalation");
    expect(prompt).toContain("eq(invoice.userId, userId)");
    // The list QUERY must be really implemented (not left as the []-returning stub),
    // and referenced by the PascalCase file name the scaffold emits (not camelCase).
    expect(prompt).toContain("Invoice.queries.ts");
    expect(prompt).toContain("Invoice.mutations.ts");
    expect(prompt).not.toContain("invoice.mutations.ts");
    // UI logic files need mirrored test siblings, not just the two API tests.
    expect(prompt).toContain("features/invoice/");
  });

  it("teaches the UI test async idiom (avoid require-await: mutateAsync+await in act, sync when no await)", () => {
    // build54 Company parked here: 9 @typescript-eslint/require-await errors — the model wrote
    // `await act(async () => { result.current.mutate(input); })` (mutate, no await → async callback
    // with no await) and `it("…", async () => { render(…); /* sync asserts */ })`. The green idiom
    // (JoinRequests.mutations.test.tsx) awaits mutateAsync inside act.
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Names the exact rule + the green mutation-test shape (await mutateAsync inside act + waitFor).
    expect(prompt).toContain("require-await");
    expect(prompt).toContain(
      "await act(async () => { await result.current.mutateAsync(input); });"
    );
    expect(prompt).toContain("await waitFor(");
    // References the scaffold's gate-green mutation test.
    expect(prompt).toContain(
      "apps/ui/src/features/accounts/JoinRequests.mutations.test.tsx"
    );
    // Calls out the deliberate component(mutate)-vs-test(mutateAsync) divergence.
    expect(prompt).toContain("fire-and-forget");
    // Component render tests: async ONLY when the body awaits (findByText/waitFor), else sync.
    expect(prompt).toContain("await screen.findByText");
  });

  it("steers to Zod v4 top-level format validators (z.url/z.email), not the deprecated string methods", () => {
    // build54 Company parked partly on @typescript-eslint/no-deprecated: it wrote
    // `z.string().url(...)` for the website field. Zod v4 deprecated the string methods for
    // top-level `z.url()`/`z.email()` (the scaffold's Auth.schemas.ts uses `z.email(...)`).
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Teaches the top-level validators + names the rule.
    expect(prompt).toContain("z.url(");
    expect(prompt).toContain("z.email(");
    expect(prompt).toContain("no-deprecated");
    // Explicitly warns off the deprecated string method the model reached for.
    expect(prompt).toContain("z.string().url(msg)");
    // Also covers uuid (another top-level validator the guide names).
    expect(prompt).toContain("z.uuid(");
    // The optional-URL-allowing-empty expression (the exact shape Company's website field needs).
    expect(prompt).toContain('z.url(msg).optional().or(z.literal(""))');
    // Points at the scaffold's green reference schema.
    expect(prompt).toContain("apps/ui/src/features/auth/Auth.schemas.ts");
  });

  it("UI contract has NO dangling 'above' references on the no-slice path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    // refinePrompt(feature) WITHOUT a slice → the Product Context section (its
    // "## Product Context" header + "### UI Intent") is not emitted, so the UI
    // contract must not require reading fields from a section that isn't there.
    const prompt = refinePrompt(feature);

    expect(prompt).not.toContain("## Product Context");
    expect(prompt).not.toContain("### UI Intent");
    // No bare "Product Context above" anchor anywhere (Persistence + UI both use the
    // slice-aware fieldSource, so nothing points at a section that wasn't emitted).
    expect(prompt).not.toContain("Product Context above");
    // The contract degrades to the behavior-based fallback (no dangling anchor).
    expect(prompt).toContain("the fields implied by the behavior");
  });

  it("tells the model to WIRE UP an unused i18n key, never delete what it wrote", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // The unused-key case must steer toward wiring up, not deleting.
    expect(prompt).toContain("i18n-locale-keys-used");
    expect(prompt).toContain("WIRE IT UP");
    expect(prompt).toContain("NEVER delete a translation you just authored");
  });

  it("leads with the prior gate errors on a retry (lastError)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 1,
      lastError: "project.routes.ts:12 error TS2304: Cannot find name 'foo'",
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("PREVIOUS attempt FAILED");
    expect(prompt).toContain("TS2304: Cannot find name 'foo'");
  });

  it("omits the failure block on a first attempt (no lastError)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    expect(refinePrompt(feature)).not.toContain("PREVIOUS attempt FAILED");
  });

  it("contains the resource description", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record with line items and payment tracking",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain(
      "Customer billing record with line items and payment tracking"
    );
  });

  it("contains the API schema file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.schemas.ts");
  });

  it("instructs adding real domain columns to the entity's Drizzle table", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // The model must be told to add columns to the shared schema, and to touch
    // ONLY its own table — this is what makes persistence real, not in-memory.
    expect(prompt).toContain(
      "apps/api/src/clients/postgres/schema/app.schema.ts"
    );
    expect(prompt).toContain("invoice");
    expect(prompt.toLowerCase()).toContain("persist");
    expect(prompt).toMatch(/do not touch any other table/iu);
  });

  it("instructs adding i18n keys for every UI string to the locale files", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("i18n");
    expect(prompt).toContain("locales");
    expect(prompt).toContain("features.invoice");
    expect(prompt.toLowerCase()).toContain("parity");
  });

  it("contains the API service file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.service.ts");
  });

  it("contains the API types file path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/api/src/api/invoice/invoice.types.ts");
  });

  it("contains the UI feature path", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("apps/ui/src/features/invoice");
  });

  it("contains the required test sibling paths", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain(
      "apps/api/tests/api/invoice/invoice.routes.test.ts"
    );
    expect(prompt).toContain(
      "apps/api/tests/api/invoice/invoice.service.test.ts"
    );
  });

  it("contains freeze wording", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("freeze");
  });

  it("contains domain-fill instructions about real fields", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("field");
  });

  it("contains guidance against as casts", () => {
    const feature: IFeature = {
      id: "Customer",
      desc: "End user or organization",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt.toLowerCase()).toContain("as");
  });

  it("uses correct camelCase conversion", () => {
    const feature: IFeature = {
      id: "PaymentMethod",
      desc: "Payment storage and retrieval",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("paymentMethod");
    expect(prompt).toContain("apps/api/src/api/paymentMethod/paymentMethod");
  });

  it("refinePrompt injects the slice's fields, UI intent, and contract when given a plan slice", () => {
    const feature: IFeature = {
      id: "Bookmark",
      desc: "a link",
      passes: false,
      attempts: 0,
    };
    const slice: ISlice = {
      entity: {
        id: "Bookmark",
        desc: "a link",
        fields: [{ name: "description", type: "string", optional: true }],
        relationships: ["belongsTo User"],
        rules: ["url required"],
      },
      ui: {
        screens: ["list", "form"],
        action: "save → list",
        shows: ["url", "description"],
        nav: "Bookmarks",
      },
      verification: {
        mustRemainTrue: ["auth"],
        mustNotHappen: ["no url"],
        acceptanceCheck: "bun test",
      },
    };
    const p = refinePrompt(feature, slice);

    expect(p).toContain("description"); // the field it kept dropping
    expect(p).toContain("belongsTo User");
    expect(p).toContain("save → list"); // UI intent
    expect(p).toContain("url required"); // rule
    // The slice branch of domainFields must actually be taken — a regression that
    // always used the no-slice fallback would still pass the assertions above.
    expect(p).toContain("the entity's **Fields** in Product Context above");
    expect(p).not.toContain("the fields implied by the behavior");
    // Display is a rendering hint, NOT columns/inputs (no domain-contract corruption).
    expect(p).toContain("**Display** list is for rendering only");
  });

  it("refinePrompt without a slice is unchanged (contains id + desc)", () => {
    const p = refinePrompt({
      id: "Bookmark",
      desc: "a link",
      passes: false,
      attempts: 0,
    });

    expect(p).toContain("Bookmark");
  });

  it("teaches the THROWING-client error idiom: never check `error` (it is typed undefined)", () => {
    const p = refinePrompt({
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    });

    // The boringstack client's throwOnError middleware THROWS on non-2xx and types
    // `error` as undefined — so mutations/queries must never guard `error`. The prompt
    // names the old "if (error) throw error" idiom only to forbid it (calling it a DEAD
    // no-unnecessary-condition / only-throw-error). Because `data` is typed OPTIONAL, the
    // create/update return is GUARD-then-return (not a bare `return data`).
    expect(p).toContain("throwOnError");
    expect(p).toContain(
      "const { data } = await apiClient.POST(…, { body: input }); if (!data) throw new ApiError"
    );
    expect(p).toContain("no-unnecessary-condition");
    expect(p).toContain("only-throw-error");
    // The wrong "does NOT throw" framing must be gone.
    expect(p).not.toContain("does NOT throw");
  });

  it("forces an ownership-isolation test so the userId security clause is verified, not just prose", () => {
    const p = refinePrompt({
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    });

    expect(p).toContain("ownership-isolation test");
    expect(p).toContain("user B"); // another user cannot read/update/delete A's row
    expect(p.toLowerCase()).toContain("privilege");
  });

  it("requires the UI test to drive edit AND delete from the list, not just create", () => {
    const p = refinePrompt({
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    });

    expect(p).toContain("the update mutation fires");
    expect(p).toContain("the delete mutation fires");
    expect(p).toContain("MUST drive edit and delete from the rendered list");
  });

  it("instructs the model to use the `check` tool and forbids running the gate via shell (WS-G contract)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // WS-G: the callable gate replaced the old "do NOT run the gate yourself".
    expect(prompt).toContain("check");
    expect(prompt).toContain("passed: true");
    // Shell gate execution is still forbidden (check is a tool, not `npx tsc`).
    expect(prompt).toContain("Do NOT run the gate through the shell");
    expect(prompt).not.toContain("Do NOT run the gate yourself");
    // #63b: the model must NOT run the browser E2E / dev server itself — that hits the host
    // preflight guard (exit 1) while the dockerized dev server is up and traps it into a park.
    // Assert the LOAD-BEARING content (not just the heading): the command prohibitions, the
    // harness-owned-acceptance statement, and the stop-at-fast-gate-green instruction — the exact
    // behaviors this root-cause fix depends on, so removing any of them fails the test.
    expect(prompt).toContain(
      "Do NOT run the browser end-to-end acceptance yourself"
    );
    expect(prompt).toContain("preflight-host-dev.sh");
    // the specific commands the model must not run
    expect(prompt).toContain("playwright");
    expect(prompt).toContain("bun run dev");
    // acceptance is the harness's job, run automatically after the fast gate
    expect(prompt).toMatch(
      /harness runs the full browser[\s\S]*AUTOMATICALLY/u
    );
    // and the model must STOP at fast-gate green rather than "verify" further
    expect(prompt).toMatch(/passed: true[\s\S]*you are DONE/u);
  });

  it("front-loads BoringStack UI component conventions (makeIdHandler list-row idiom, module split, api-client typed unwrap)", () => {
    const feature: IFeature = {
      id: "Invoice",
      desc: "Customer billing record",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Must teach the UI conventions section.
    expect(prompt).toContain("BoringStack UI component conventions");
    // Must teach the #1 jsx-no-bind churn source.
    expect(prompt).toContain("jsx-no-bind");
    // Must teach the makeIdHandler curried list-row idiom to avoid arrow functions in JSX.
    expect(prompt).toContain("makeIdHandler");
    // Must forbid JSX in .ts files (JSX only compiles in .tsx).
    expect(prompt).toContain("JSX only compiles in `.tsx`");
    expect(prompt).toContain("Parsing error: '>' expected");
    // Must teach module separation (component in .tsx, hooks in .hooks.ts, helpers in .utils.ts).
    expect(prompt).toContain(".hooks.ts");
    expect(prompt).toContain(".utils.ts");
    expect(prompt).toContain(".types.ts");
    // (api-client data-fetching idiom is taught by the existing data-fetching
    // section, not the UI-component conventions — no duplicate/contradictory copy here.)
  });

  it("teaches the reachability contract: register nav + route, ADD-ONLY", () => {
    const feature: IFeature = {
      id: "Company",
      desc: "A business the sales team works with",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Must instruct wiring the feature into BOTH the sidebar and the router so it is reachable.
    expect(prompt).toContain("AppSidebar");
    expect(prompt).toContain("routes.tsx");
    // The sidebar registration is via the scaffold's nav-items array (which renders
    // the nav-<key> testid the acceptance gate navigates by).
    expect(prompt).toContain("APP_SIDEBAR_NAV_ITEMS");
    // Must carry the add-only boundary for those shared files.
    expect(prompt).toContain("ADD ONLY");
    // Post-#183 the FAST per-feature gate runs the sidebar's co-located nav-count test, so the
    // guidance must tell the model a stale count fails THIS cycle — not merely the final validate
    // (understating the urgency lets the model defer the count bump and spray the fast gate).
    expect(prompt).toContain("per-feature gate fails THIS cycle");
    expect(prompt).not.toContain(
      "otherwise the final full-project validate fails"
    );
  });

  it("teaches the scaffold's api-client hook typing: annotate the DOMAIN type, never Readable/as (kills the near-green cluster)", () => {
    // build44/45 oscillated on the api-client response cluster (Readable<SuccessResponse> / no-as /
    // Unnecessary ?? / not-assignable). The scaffold's green hooks ANNOTATE with the domain type;
    // the guide must teach that exact shape (and must not tell the model to drop annotations).
    const feature: IFeature = {
      id: "Company",
      desc: "A business",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Query hook annotated with the domain type + the correct `data ?? []` unwrap.
    expect(prompt).toContain("UseQueryResult<ICompanyItem[]>");
    expect(prompt).toContain("Promise<ICompanyItem[]>");
    expect(prompt).toContain("return data ?? []");
    // Mutation hook annotated with the domain type (3-generic form).
    expect(prompt).toContain(
      "UseMutationResult<ICompanyItem, unknown, CompanyCreateInput>"
    );
    // create/update: the client types `data` OPTIONAL, so bare `return data` fails — the scaffold's
    // idiom is GUARD-then-return (the guard narrows `IItem | undefined` → `IItem`).
    expect(prompt).toContain("GUARD, then return");
    expect(prompt).toContain("if (!data) throw new ApiError");
    // delete returns nothing (`t.Null()` route) — it must be typed `void`, never the item type.
    expect(prompt).toContain("UseMutationResult<void, unknown, string>");
    expect(prompt).toContain("response: t.Null()");
    // Two DIFFERENT errors. (a) `Readable<SuccessResponse<...>>` not-assignable (tsc prints the
    // abbreviated `<...>` — the REAL string) = `data` did NOT RESOLVE to the domain type: the fix is
    // UPSTREAM (the route's `response:` schema must match the item type; stale schema regenerates via
    // generate:api). `?? []`/guard/`as` CANNOT convert the wrapper — so this is NOT a consumer-unwrap
    // fix. (b) `T | undefined not assignable` = data resolved but optional; THAT is the `?? []`/guard.
    expect(prompt).toContain("Two DIFFERENT errors");
    expect(prompt).toContain("Readable<SuccessResponse<...>>");
    // Pin the round-14 core claim for (a): did-not-resolve + upstream, and that the tricks can't convert.
    expect(prompt.toLowerCase()).toContain("did not resolve");
    expect(prompt.toLowerCase()).toContain("upstream");
    expect(prompt.toLowerCase()).toContain("none converts the wrapper");
    expect(prompt).toContain("return data.data");
    expect(prompt).toContain("const { data } = await apiClient.GET");
    expect(prompt).toContain("generate:api");
    // It must not resurrect the panel-flagged falsehoods (annotation-is-the-fix, or the fabricated
    // empty-inner `{ 200: {} }` = missing-schema tell that tsc never actually prints).
    expect(prompt).not.toContain("the domain annotation does all the work");
    expect(prompt).not.toContain("{ 200: {} }");
    // Never Readable-annotate, never `as`-cast, never drop the annotation (the two dead ends).
    expect(prompt).toContain(
      "annotate a hook with `Readable<SuccessResponse<…>>`"
    );
    expect(prompt).toContain("`as`-cast");
    expect(prompt.toLowerCase()).toContain(
      "remove the annotation and let ts infer"
    );
  });

  it("teaches query keys as constants in *.constants.ts (never an inline string-array queryKey)", () => {
    // build42 Contact parked partly on nonConstantQueryKey: `queryKey: ["contact", id]` (an array
    // literal starting with a string) is rejected; keys must be a constant from *.constants.ts.
    const feature: IFeature = {
      id: "Contact",
      desc: "A contact",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("USE the generated constant");
    expect(prompt).toContain("CONTACT_QUERY_KEYS");
    expect(prompt).toContain("Contact.constants.ts");
    // Must match the SCAFFOLD's shape: a static tuple accessed as a PROPERTY (.list), not a call —
    // the reviewer flagged that inventing all/list()/detail() factories fights the generated files.
    expect(prompt).toContain('list: ["contact", "list"] as const');
    expect(prompt).toContain("queryKey: CONTACT_QUERY_KEYS.list, ");
    // Invalidate with the SAME property key (so the list refreshes).
    expect(prompt).toContain(
      "invalidateQueries({ queryKey: CONTACT_QUERY_KEYS.list })"
    );
    // A factory is taught ONLY for a parameterized key (detail(id)), never rewriting the static list.
    expect(prompt).toContain("detail: (id: string) =>");
    expect(prompt).toContain("Do NOT rewrite the existing static");
    // Lock out BOTH earlier mis-teachings: the inline-spread loophole AND the factory .list() rewrite.
    expect(prompt).not.toContain("a spread of the constant is fine");
    expect(prompt).not.toContain("QUERY_KEYS.list()");
  });

  it("bans STATE-primitive hooks in the JSX body but ALLOWS custom hooks / useTranslation inline", () => {
    // build36 Company ground near-green on "must be in a custom hook (.hooks.ts), not in component
    // body". The rule bans only the STATE primitives directly in a JSX-returning body; custom hooks,
    // useTranslation(), and useId/useTransition/useDeferredValue are legal in the body (the scaffold's
    // JoinRequestsPage body calls both useTranslation() and useJoinRequestsPage()).
    const feature: IFeature = {
      id: "Company",
      desc: "A business the sales team works with",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("STATE-PRIMITIVE hooks");
    // The exact eslint message (accurate, not a paraphrase).
    expect(prompt).toContain(
      "must be in a custom hook (.hooks.ts), not in component body"
    );
    // The exceptions the eslint rule + scaffold require MUST be documented (not an over-broad ban).
    expect(prompt).toContain("useTranslation()");
    expect(prompt).toContain("useJoinRequestsPage()");
    // The default-allowed built-ins are also legal inline — pin them so a regression can't drop them.
    expect(prompt).toContain("useId");
    expect(prompt).toContain("useTransition");
    expect(prompt).toContain("useDeferredValue");
    // makeIdHandler is the no-hook row-handler fix.
    expect(prompt).toContain("NO hook at all");
    // The old trap phrasing must be gone.
    expect(prompt).not.toContain(
      "child component with a useCallback is an alternative"
    );
    // And it must NOT freeze either over-broad/impossible wording from earlier rounds.
    expect(prompt).not.toContain("may NEVER be called in a component body");
    expect(prompt).not.toContain("may only CALL that one custom hook");
  });

  it("teaches the exact no-jsx-computation idiom (const list + bare identifier; warns the declare-but-inline rotation)", () => {
    // build38 Contact parked here: the model declared `const companyOptions = companies.map(...)` but
    // ALSO inlined `{companies.map(...)}` in the <select> → no-jsx-computation (inline map) +
    // no-unused-vars (ignored const), which rotate. The guide must name the exact rule + fix + trap.
    const feature: IFeature = {
      id: "Company",
      desc: "A business",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("no-jsx-computation");
    // The compliant idiom: reference the bare identifier in JSX, never inline the array method.
    expect(prompt).toContain("{renderRows}");
    expect(prompt).toContain("never inline the");
    // The rotation trap is called out explicitly (declare const + inline map → two rotating errors).
    expect(prompt).toContain("no-unused-vars");
  });

  it("teaches the exact form-submit idiom (void handleSubmit → no-misused-promises + jsx-no-bind)", () => {
    // build53 Company parked here: the model wrote `onSubmit={createForm.handleSubmit((v) => …)}`,
    // whose attribute value is a CALL EXPRESSION → @typescript-eslint/no-misused-promises only
    // ("Promise-returning function provided to attribute where a void return was expected"); the
    // log shows NO jsx-no-bind hit (a call expression passes jsx-no-bind, per the row-handler rule).
    // The model then fumbled BaseSyntheticEvent and couldn't close. The green idiom (scaffold
    // LoginPage.hooks.ts): a hook-owned void-returning `submit` used as a bare ref.
    const feature: IFeature = {
      id: "Company",
      desc: "A business",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    // Names the exact rule the inline handleSubmit trips.
    expect(prompt).toContain("no-misused-promises");
    // The form-submit guidance co-locates BOTH rules it satisfies (not just row-handler jsx-no-bind).
    expect(prompt).toContain("`no-misused-promises` + `jsx-no-bind` idiom");
    // LOCK the corrected distinction (consistent with the guide's own row-handler rule): the
    // direct call expression is NOT a jsx-no-bind violation; only the inline-arrow variant is.
    // These fail if the old dual-rule claim ("call expression trips both") is ever restored.
    expect(prompt).toContain(
      "a call expression, so `jsx-no-bind` is NOT the issue here"
    );
    expect(prompt).toContain(
      "an inline arrow `onSubmit={(e) => form.handleSubmit(onValid)(e)}` trips `jsx-no-bind`"
    );
    // Teaches the void-operator wrap that makes the handler return void.
    expect(prompt).toContain("void handleSubmit(onSubmit)(event)");
    // The submit handler uses fire-and-forget `mutate` (errors → onError), NOT `mutateAsync`
    // which would reject and make the `void` wrapper discard a rejected promise.
    expect(prompt).toContain("createMutation.mutate(input)");
    expect(prompt).toContain("unhandled rejection");
    // Must steer AWAY from copying LoginPage verbatim (it uses mutateAsync+try/catch to
    // navigate on the result) so the model doesn't paste mutateAsync into the void wrapper.
    expect(prompt).toContain("never `mutateAsync` here");
    // Must NOT make the false blanket claim that the void wrapper can't leak a rejection.
    expect(prompt).not.toContain("can't reject, so");
    // Points at the scaffold's green reference form hook.
    expect(prompt).toContain(
      "apps/ui/src/features/auth/components/LoginPage/LoginPage.hooks.ts"
    );
    // The form JSX passes the bare hook reference, never handleSubmit inline.
    expect(prompt).toContain("onSubmit={view.submit}");
    // Pins the scaffold's ACTUAL create-input token (no I- prefix; the item type has one,
    // the input does not) so the idiom can't drift back to the invented ICompanyCreateInput
    // that caused build53's rename churn.
    expect(prompt).toContain("CompanyCreateInput");
    expect(prompt).not.toContain("ICompanyCreateInput");
    // The useCallback depends on the STABLE `mutate`, not the unstable mutation result object,
    // so the handler stays referentially stable (avoids TanStack's no-unstable-deps).
    expect(prompt).toContain("[createMutation.mutate]");
    expect(prompt).toContain("no-unstable-deps");
  });

  it("warns that every NEW component needs the FULL sibling set → don't extract sub-components", () => {
    // build36 hit component-folder-structure: a new 'CompanyFormField' demanded .hooks/.types/
    // .stories/.test/index siblings. The guide must warn and steer to inline instead.
    const feature: IFeature = {
      id: "Company",
      desc: "A business",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain("component-folder-structure");
    expect(prompt).toContain("Do NOT create new sub-components");
    // Pin the FULL required sibling set (a partial regression of this list must fail).
    expect(prompt).toContain(".hooks.ts");
    expect(prompt).toContain(".types.ts");
    expect(prompt).toContain(".stories.tsx");
    expect(prompt).toContain(".test.tsx");
    expect(prompt).toContain("index.ts");
  });

  it("teaches the test-file extension rule: a test that renders JSX must be .test.tsx", () => {
    // build33/35 parked on `.hooks.test.ts` files that render JSX → `'>' expected`.
    const feature: IFeature = {
      id: "Company",
      desc: "A business",
      passes: false,
      attempts: 0,
    };

    const prompt = refinePrompt(feature);

    expect(prompt).toContain(".test.tsx");
    expect(prompt).toContain("hooks.test.tsx");
    expect(prompt).toContain("renderHook");
  });
});
