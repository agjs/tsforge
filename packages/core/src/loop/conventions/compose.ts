import type { IConventionProvider } from "../conventions-provider";

/**
 * Compose convention providers: later providers override earlier ones for the
 * same topic id. Topics() is the union (deduped, earlier-first then new).
 * buildGuides() returns the short pull contract from the composed topic list —
 * never a wall of full guide bodies.
 */
export function composeConventionProviders(
  ...providers: readonly IConventionProvider[]
): IConventionProvider {
  const topicOrder: string[] = [];
  const seenTopics = new Set<string>();

  for (const p of providers) {
    for (const t of p.topics()) {
      if (seenTopics.has(t)) {
        continue;
      }

      seenTopics.add(t);
      topicOrder.push(t);
    }
  }

  return {
    // First provider that claims the topic owns its rule list, matching how
    // `guide` resolves — an override must not silently change what backs it.
    rulesForTopic: (topic) => {
      for (const p of providers) {
        const rules = p.rulesForTopic(topic);

        if (rules.length > 0) {
          return rules;
        }
      }

      return [];
    },
    buildGuides: () => {
      // Prefer the last provider that returns a non-empty contract; fall back to
      // joining topic names if somehow empty.
      for (let i = providers.length - 1; i >= 0; i--) {
        const g = providers[i]?.buildGuides() ?? "";

        if (g.length > 0) {
          return g;
        }
      }

      return `CONVENTIONS — call pull_conventions before first write. Topics: ${topicOrder.join(", ")}.`;
    },
    guide: (topic) => {
      for (let i = providers.length - 1; i >= 0; i--) {
        const g = providers[i]?.guide(topic) ?? null;

        if (g !== null) {
          return g;
        }
      }

      return null;
    },
    topics: () => topicOrder,
    unseenForErrors: (errors, seen) => {
      // Later providers first so overrides mark `seen` and supply their guide
      // text (house must not PUSH a generic guide when BoringStack overrides it).
      const out: string[] = [];

      for (let i = providers.length - 1; i >= 0; i--) {
        const p = providers[i];

        if (p === undefined) {
          continue;
        }

        for (const g of p.unseenForErrors(errors, seen)) {
          out.push(g);
        }
      }

      return out;
    },
    ...(providers.some((p) => p.topicsForPath !== undefined)
      ? {
          topicsForPath: (file: string): readonly string[] => {
            const out: string[] = [];
            const seen = new Set<string>();

            for (const p of providers) {
              if (p.topicsForPath === undefined) {
                continue;
              }

              for (const topic of p.topicsForPath(file)) {
                if (seen.has(topic) || !seenTopics.has(topic)) {
                  continue;
                }

                seen.add(topic);
                out.push(topic);
              }
            }

            return out;
          },
        }
      : {}),
  };
}
