import type { IConventionProvider } from "../conventions-provider";
import { disabledRulesInProfile, type ProfileId } from "../../config/profiles";

/**
 * Footer appended to a guide whose rules the active profile does not enforce.
 *
 * A greenfield React build ran on the default profile — where the structure
 * rules are off — while the component-anatomy guide claimed "the sibling set the
 * gate requires". The gate passed flat single-file components, so the model
 * reasonably concluded the folder layout was aspirational and stopped following
 * it. A guide that says "must" while the gate says "optional" teaches the model
 * that guides are advisory, and the model then optimizes for the only thing that
 * can actually fail it.
 *
 * Stating the split makes every guide true under every profile, instead of true
 * only under the strictest one.
 */
export function enforcementFooter(
  rules: readonly string[],
  disabled: ReadonlySet<string>
): string | null {
  const off = rules.filter((r) => disabled.has(r));

  if (off.length === 0) {
    return null;
  }

  const on = rules.filter((r) => !disabled.has(r));
  const enforced =
    on.length > 0
      ? `The gate DOES fail on: ${on.join(", ")}.`
      : "The gate fails on none of this topic's rules here.";

  return (
    `IN THIS PROFILE: ${off.join(", ")} ${off.length === 1 ? "is" : "are"} NOT enforced — ` +
    `the gate will not fail you for ignoring that part, so it is house style rather than a ` +
    `build error. ${enforced} Run the \`opinionated\` profile to make it fail the build.`
  );
}

/**
 * Wrap a provider so every guide it serves states what the ACTIVE profile
 * enforces. Applied once, in the session, so injected adapter providers
 * (BoringStack and any future stack) are covered on the same terms as the house
 * library — none of them has to know about profiles.
 */
export function withProfileEnforcement(
  base: IConventionProvider,
  profile: ProfileId | undefined
): IConventionProvider {
  const disabled = disabledRulesInProfile(profile);

  if (disabled.size === 0) {
    return base;
  }

  const annotate = (topic: string, text: string): string => {
    const footer = enforcementFooter(base.rulesForTopic(topic), disabled);

    return footer === null ? text : `${text}\n\n${footer}`;
  };

  return {
    buildGuides: () => base.buildGuides(),
    topics: () => base.topics(),
    rulesForTopic: (topic) => base.rulesForTopic(topic),
    guide: (topic) => {
      const text = base.guide(topic);

      return text === null ? null : annotate(topic, text);
    },
    // The reactive PUSH serves the same bodies after a red gate, so it has to
    // carry the same caveat — otherwise the two paths disagree.
    unseenForErrors: (errors, seen) => {
      const before = new Set(seen);
      const guides = base.unseenForErrors(errors, seen);
      // `seen` is a Set, so iteration is insertion order: the topics added by
      // that call line up 1:1, in order, with the guides it returned.
      const added = [...seen].filter((t) => !before.has(t));

      return guides.map((text, i) => {
        const topic = added[i];

        return topic === undefined ? text : annotate(topic, text);
      });
    },
  };
}
