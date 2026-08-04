import { test, expect, describe } from "bun:test";
import { Linter, type Rule } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { RULE_PACKS } from "../src/rule-packs";
import { RULE_DOCS, type IRuleDoc } from "../src/loop/feedback/rule-docs";
import { PACK_RULE_DOCS } from "../src/loop/feedback/pack-rule-docs";

/**
 * Every published example must be TRUE.
 *
 * A rule doc is the only thing the model gets when the gate rejects its code.
 * When one describes a mechanism the rule does not have, the model does not
 * fail loudly — it goes looking for the mechanism. One such doc claimed fetch
 * URLs could "pass through an allowlisted URL builder"; no allowlist existed,
 * and an agent read tsforge's own rule source from inside an unrelated project
 * trying to find it.
 *
 * So the examples are executable: `bad` must actually trip its rule, and `good`
 * must actually satisfy it. A doc cannot drift from its rule without this
 * failing.
 */

function lint(
  packId: keyof typeof RULE_PACKS,
  ruleName: string,
  code: string,
  filename: string
): string[] {
  const pack = RULE_PACKS[packId];
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack ${packId}`);
  }

  // The pack stores TSESLint rule modules; ESLint's Linter wants its own shape.
  // They are structurally compatible at every point Linter touches, so the
  // parameter is typed as what Linter needs and the pack value is handed over
  // through a narrowing guard rather than a cast.
  const plugins = { tsforge: { rules: { [ruleName]: toLinterRule(rule) } } };
  const isTsx = filename.endsWith(".tsx");
  const linter = new Linter();

  const messages = linter.verify(
    code,
    [
      {
        files: [isTsx ? "**/*.tsx" : "**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            ...(isTsx ? { ecmaFeatures: { jsx: true } } : {}),
          },
        },
        plugins,
        rules: { [`tsforge/${ruleName}`]: "error" },
      },
    ],
    filename
  );

  return messages.map((m) => m.message);
}

/** A snippet that does not parse is not an example — and a parse error would
 *  otherwise satisfy "the ✗ example produced a message" for entirely the wrong
 *  reason, letting a broken fragment pass as a verified doc. */
function assertParses(messages: string[], label: string): void {
  const parseError = messages.find((m) => m.startsWith("Parsing error:"));

  if (parseError !== undefined) {
    throw new Error(
      `${label} is not valid standalone TypeScript — the model is meant to be able to copy it. ${parseError}`
    );
  }
}

/** Which pack owns a rule name (rule ids are unique across packs). */
function packOf(ruleName: string): keyof typeof RULE_PACKS | undefined {
  // Iterate the KEYS of the typed record, so packId is already narrowed and no
  // cast is needed to widen Object.entries' `string` back to the union.
  for (const packId of Object.keys(RULE_PACKS)) {
    if (!isPackId(packId)) {
      continue;
    }

    if (ruleName in RULE_PACKS[packId].rules) {
      return packId;
    }
  }

  return undefined;
}

function isPackId(value: string): value is keyof typeof RULE_PACKS {
  return Object.hasOwn(RULE_PACKS, value);
}

/** The pack's rule module in the shape ESLint's Linter accepts.
 *
 *  A pack rule is a TSESLint module; Linter wants its own. They are structurally
 *  compatible at every point Linter touches, but the two `create` signatures are
 *  nominally different, so this re-declares the one member Linter calls and
 *  forwards to it. No `as`, and no laundering through an `any`-returning helper —
 *  dodging the cast ban that way is worse than the cast itself. */
function toLinterRule(rule: unknown): Rule.RuleModule {
  if (typeof rule !== "object" || rule === null || !("create" in rule)) {
    throw new Error("rule module has no create()");
  }

  const create: unknown = Reflect.get(rule, "create");

  if (typeof create !== "function") {
    throw new Error("rule module create() is not callable");
  }

  // `meta` carries the messages table; without it a rule reporting by messageId
  // throws instead of producing a diagnostic.
  const meta: unknown = Reflect.get(rule, "meta");

  return {
    ...(typeof meta === "object" && meta !== null ? { meta } : {}),
    create(context: Rule.RuleContext): Rule.RuleListener {
      const returned: unknown = Reflect.apply(create, rule, [context]);

      if (typeof returned !== "object" || returned === null) {
        throw new Error("rule create() did not return a listener");
      }

      // A RuleListener is a string-keyed map of visitor callbacks. Rebuild it
      // from own entries so the value carries that index signature honestly
      // rather than being asserted into it.
      const listener: Rule.RuleListener = {};

      for (const [selector, visitor] of Object.entries(returned)) {
        // Visitors are usually functions, but a selector may also carry an
        // { enter, exit } pair — keep both or half the rules stop firing.
        if (typeof visitor === "function" || typeof visitor === "object") {
          listener[selector] = visitor;
        }
      }

      return listener;
    },
  };
}

interface IDocumented {
  id: string;
  ruleName: string;
  packId: keyof typeof RULE_PACKS;
  doc: IRuleDoc;
}

const documented: IDocumented[] = [];

const ALL_DOCS: Record<string, IRuleDoc> = { ...PACK_RULE_DOCS, ...RULE_DOCS };

for (const [id, doc] of Object.entries(ALL_DOCS)) {
  if (!id.startsWith("tsforge/")) {
    continue; // TS diagnostics and eslint-core rules aren't lintable here
  }

  if (doc.bad.length === 0 || doc.good.length === 0) {
    continue;
  }

  if (doc.exampleIsProse === true) {
    continue; // file-layout illustration, not compilable code
  }

  const ruleName = id.slice("tsforge/".length);
  const packId = packOf(ruleName);

  if (packId !== undefined) {
    documented.push({ id, ruleName, packId, doc });
  }
}

describe("rule docs: every published example is executable", () => {
  test("there is something to check", () => {
    expect(documented.length).toBeGreaterThan(0);
  });

  test.each(documented.map((d) => [d.id, d]))(
    "%s: the ✗ example really trips the rule",
    (_id, entry) => {
      const { packId, ruleName, doc } = entry;
      const messages = lint(
        packId,
        ruleName,
        doc.bad,
        doc.exampleFile ?? "src/example.ts"
      );

      assertParses(messages, `${_id} ✗ example`);
      expect(messages.length).toBeGreaterThan(0);
    }
  );

  test.each(documented.map((d) => [d.id, d]))(
    "%s: the ✓ example really satisfies it",
    (_id, entry) => {
      const { packId, ruleName, doc } = entry;
      const messages = lint(
        packId,
        ruleName,
        doc.good,
        doc.goodFile ?? doc.exampleFile ?? "src/example.ts"
      );

      assertParses(messages, `${_id} ✓ example`);
      expect(messages).toEqual([]);
    }
  );
});

describe("rule docs: coverage", () => {
  test("every pack rule tells the model something actionable", () => {
    // The guarantee is NOT "every rule has an example" — an invented example is
    // worse than none, which is how a doc came to promise an "allowlisted URL
    // builder" that did not exist. It is: every rule the gate can fail on ships
    // either a VERIFIED bad→good pair or a hand-written procedure.
    const bare: string[] = [];

    for (const [, pack] of Object.entries(RULE_PACKS)) {
      for (const ruleName of Object.keys(pack.rules)) {
        const doc = ALL_DOCS[`tsforge/${ruleName}`];
        // A prose entry is exempt from EXECUTION, not from carrying guidance:
        // its bad/good are file layouts, so only the procedure actually tells
        // the model what to do.
        const hasExample =
          doc !== undefined &&
          doc.exampleIsProse !== true &&
          doc.bad.length > 0 &&
          doc.good.length > 0;
        const hasProcedure =
          doc?.procedure !== undefined && doc.procedure.length > 0;

        if (!hasExample && !hasProcedure) {
          bare.push(ruleName);
        }
      }
    }

    expect(bare).toEqual([]);
  });

  test("a doc with no example must explain itself in a procedure", () => {
    const silent = Object.entries(ALL_DOCS)
      .filter(([id]) => id.startsWith("tsforge/"))
      .filter(
        ([, doc]) =>
          doc.exampleIsProse === true ||
          doc.bad.length === 0 ||
          doc.good.length === 0
      )
      .filter(([, doc]) => (doc.procedure ?? "").length === 0)
      .map(([id]) => id);

    expect(silent).toEqual([]);
  });
});

/** Strip whitespace so two snippets can be compared for structural sameness. */
function squash(code: string): string {
  return code.replace(/\s+/gu, " ").trim();
}

describe("rule docs: the ✓ must be a FIX, not an evasion", () => {
  // The executable checks only prove the ✓ does not trip the rule. A snippet can
  // achieve that by escaping the rule's scope instead of repairing the code —
  // adding "use client" while keeping the offending fetch, or deleting the
  // triggering line and teaching nothing. Those pass linting and mislead the
  // model, which is the exact defect this whole file exists to prevent.

  test.each(documented.map((d) => [d.id, d]))(
    "%s: the ✓ is not the ✗ with the offending code simply removed",
    (_id, entry) => {
      const bad = squash(entry.doc.bad);
      const good = squash(entry.doc.good);

      // A ✓ that is a strict substring of the ✗ is a deletion, not a fix.
      expect(bad.includes(good)).toBe(false);
    }
  );

  test.each(documented.map((d) => [d.id, d]))(
    "%s: the ✓ does not merely bolt a directive onto the ✗",
    (_id, entry) => {
      if (entry.doc.fixIsDirective === true) {
        return; // for these rules the directive IS the fix
      }

      const stripped = squash(
        entry.doc.good.replace(/^\s*["']use (client|server)["'];?\s*$/gmu, "")
      );

      // Removing an added directive must not collapse the ✓ back into the ✗:
      // that means the only "fix" was moving the file out of the rule's scope.
      expect(stripped).not.toBe(squash(entry.doc.bad));
    }
  );
});

describe("rule docs: guidance says what to DO", () => {
  // "Disallow X" restates the linter. The model already knows what it did
  // wrong; what it needs is the sanctioned shape. Every entry must therefore
  // name a remedy somewhere — in the `what`, the ✓, or the procedure.
  const REMEDY =
    /\b(use|instead|prefer|move|add|wrap|return|pass|import|call|set|declare|extract|split|parse|mask|derive|sanitize|scope|filter|guard|throw|chain|annotate|revalidate|register|write|assign|put|store|name|create|replace|delete|configure|close|bound|keep|give|drop|pick|redirect)\b/iu;

  test.each(
    Object.entries(ALL_DOCS).filter(([id]) => id.startsWith("tsforge/"))
  )("%s: names a remedy, not just a prohibition", (_id, doc) => {
    const carriesRemedy =
      REMEDY.test(doc.what) ||
      REMEDY.test(doc.procedure ?? "") ||
      doc.good.length > 0;

    expect(carriesRemedy).toBe(true);
  });
});
