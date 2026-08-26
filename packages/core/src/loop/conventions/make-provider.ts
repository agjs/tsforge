import type { IConventionProvider } from "../conventions-provider";
import { renderProbedPathTopicMap } from "./path-topics";
import { buildPullContract } from "./pull-contract";

/**
 * Shared factory for topic→guide convention libraries (house + BoringStack
 * extras). Keeps reactive PUSH / pull / topic enum in one place.
 */
export function makeConventionProvider<T extends string>(opts: {
  readonly topics: readonly T[];
  readonly guides: Readonly<Record<T, string>>;
  readonly topicRules: Readonly<Record<T, readonly string[]>>;
  /** Extra message patterns that push a topic when no rule id maps (e.g. forms). */
  readonly messagePush?: readonly {
    readonly topic: T;
    readonly pattern: RegExp;
  }[];
  /** Stack-specific path → topics. Absent → core React mapper at the pull gate. */
  readonly topicsForPath?: (file: string) => readonly string[];
  /** Probe samples for `buildGuides()` when `topicsForPath` is set. */
  readonly pathProbes?: readonly {
    readonly label: string;
    readonly sample: string;
  }[];
}): IConventionProvider {
  const topicSet = new Set<string>(opts.topics);
  const isTopic = (s: string): s is T => topicSet.has(s);

  const topicForRule = (rule: string): T | null => {
    const bare = rule.split("/").pop() ?? rule;

    for (const topic of opts.topics) {
      if (opts.topicRules[topic].includes(bare)) {
        return topic;
      }
    }

    return null;
  };

  const pathMap =
    opts.topicsForPath !== undefined && opts.pathProbes !== undefined
      ? renderProbedPathTopicMap(
          opts.topics,
          opts.topicsForPath,
          opts.pathProbes
        )
      : undefined;

  return {
    buildGuides: () => buildPullContract(opts.topics, pathMap),
    guide: (topic) => (isTopic(topic) ? opts.guides[topic] : null),
    topics: () => [...opts.topics],
    rulesForTopic: (topic) => (isTopic(topic) ? opts.topicRules[topic] : []),
    ...(opts.topicsForPath === undefined
      ? {}
      : { topicsForPath: opts.topicsForPath }),
    unseenForErrors: (errors, seen) => {
      const out: string[] = [];

      for (const e of errors) {
        if (e.rule === undefined) {
          continue;
        }

        const topic = topicForRule(e.rule);

        if (topic === null || seen.has(topic)) {
          continue;
        }

        seen.add(topic);
        out.push(opts.guides[topic]);
      }

      for (const mp of opts.messagePush ?? []) {
        if (seen.has(mp.topic)) {
          continue;
        }

        if (
          !errors.some((e) =>
            mp.pattern.test(`${e.rule ?? ""} ${e.message ?? ""}`)
          )
        ) {
          continue;
        }

        seen.add(mp.topic);
        out.push(opts.guides[mp.topic]);
      }

      return out;
    },
  };
}
