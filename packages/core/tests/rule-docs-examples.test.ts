import { test, expect, describe } from "bun:test";
import { TSESLint } from "@typescript-eslint/utils";
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

  // TSESLint ships a Linter typed for TSESLint rule modules, which is what the
  // packs hold. Using it instead of ESLint's own Linter removes the type bridge
  // entirely — no cast, and a genuine shape mismatch would now fail typecheck
  // instead of being asserted away.
  const plugins = { tsforge: { rules: { [ruleName]: rule } } };
  const isTsx = filename.endsWith(".tsx");
  const linter = new TSESLint.Linter();

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
    "%s: the ✓ repairs the ✗ rather than replacing it with unrelated code",
    (_id, entry) => {
      // Rename-to-escape and swap-in-unrelated-code both dodge the rule while
      // passing the lint check. A real fix keeps most of the original's
      // vocabulary; an unrelated snippet shares almost none of it.
      const ids = (code: string): Set<string> =>
        new Set(code.match(/[A-Za-z_$][\w$]*/gu) ?? []);
      const bad = ids(entry.doc.bad);
      const good = ids(entry.doc.good);
      const shared = [...bad].filter((t) => good.has(t)).length;
      const overlap = bad.size === 0 ? 1 : shared / bad.size;

      expect({ id: _id, overlapAtLeast30Percent: overlap >= 0.3 }).toEqual({
        id: _id,
        overlapAtLeast30Percent: true,
      });
    }
  );

  test.each(documented.map((d) => [d.id, d]))(
    "%s: the ✓ does not escape by moving to another file",
    (_id, entry) => {
      // goodFile may differ ONLY where relocating the file IS the documented
      // fix — otherwise a different path silently takes the snippet out of the
      // rule's scope and the example proves nothing.
      const escapes =
        entry.doc.goodFile !== undefined &&
        entry.doc.goodFile !== entry.doc.exampleFile &&
        entry.doc.exampleIsProse !== true &&
        entry.doc.fixIsRelocation !== true;

      expect({ id: _id, escapes }).toEqual({ id: _id, escapes: false });
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

describe("rule docs: a relocation fix must actually need the move", () => {
  // `fixIsRelocation` exempts an entry from the path-escape check. Without
  // proving the move is what does the work, that flag is just a way to smuggle
  // a same-file evasion past the suite — drop the directive, keep everything
  // else, and call it a relocation.
  const relocations = documented.filter(
    (d) => d.doc.fixIsRelocation === true && d.doc.goodFile !== undefined
  );

  test.each(relocations.map((d) => [d.id, d]))(
    "%s: the ✓ still trips the rule at the ORIGINAL path",
    (_id, entry) => {
      const atOriginal = lint(
        entry.packId,
        entry.ruleName,
        entry.doc.good,
        entry.doc.exampleFile ?? "src/example.ts"
      );

      // If the ✓ passes where the ✗ lived, the move was decorative and the real
      // change was something else — which the reader is not being shown.
      expect({ id: _id, needsTheMove: atOriginal.length > 0 }).toEqual({
        id: _id,
        needsTheMove: true,
      });
    }
  );
});

describe("rule docs: no orphaned entries", () => {
  test("every tsforge doc key names a rule that actually exists", () => {
    // A doc for a renamed or deleted rule is never looked up: no error will
    // carry that id, so it rots unnoticed. The coverage test iterates rules,
    // not doc keys, so it cannot see this.
    const real = new Set<string>();

    for (const pack of Object.values(RULE_PACKS)) {
      for (const ruleName of Object.keys(pack.rules)) {
        real.add(`tsforge/${ruleName}`);
      }
    }

    const orphans = Object.keys(ALL_DOCS)
      .filter((id) => id.startsWith("tsforge/"))
      .filter((id) => !real.has(id));

    expect(orphans).toEqual([]);
  });
});
