import { isArray, isRecord } from "../../lib/guards";
import { redactForRetain } from "./redact";
import { formatDecisionBrief } from "./format-brief";
import {
  DECISION_CONTEXT,
  DECISION_RECALL_QUERY,
  type IMemoryProvider,
} from "./provider.types";

export interface IHttpMemoryFetch {
  (
    url: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

function bankPath(baseUrl: string, bankId: string, suffix: string): string {
  const base = baseUrl.replace(/\/$/u, "");
  const encoded = encodeURIComponent(bankId);

  return `${base}/v1/default/banks/${encoded}${suffix}`;
}

function resultsToText(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const results = body.results;

  if (!isArray(results)) {
    return null;
  }

  const lines: string[] = [];

  for (const item of results) {
    if (!isRecord(item)) {
      continue;
    }

    const text = item.text;

    if (typeof text === "string" && text.trim().length > 0) {
      lines.push(text.trim());
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function listToTexts(body: unknown): readonly string[] {
  if (!isRecord(body)) {
    return [];
  }

  // Hindsight list shapes vary; accept `memories` or `items` or `results`.
  const candidates = [body.memories, body.items, body.results];

  for (const candidate of candidates) {
    if (!isArray(candidate)) {
      continue;
    }

    const out: string[] = [];

    for (const item of candidate) {
      if (typeof item === "string" && item.trim().length > 0) {
        out.push(item.trim());
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      const text = item.text ?? item.content;

      if (typeof text === "string" && text.trim().length > 0) {
        out.push(text.trim());
      }
    }

    if (out.length > 0) {
      return out;
    }
  }

  return [];
}

export function createHttpMemoryProvider(
  bankId: string,
  baseUrl: string,
  fetchFn: IHttpMemoryFetch = fetch
): IMemoryProvider {
  return {
    bankId,

    async recall(query: string): Promise<string | null> {
      try {
        const res = await fetchFn(bankPath(baseUrl, bankId, "/memories/recall"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: query.length > 0 ? query : DECISION_RECALL_QUERY,
            max_tokens: 800,
            budget: "low",
          }),
        });

        if (!res.ok) {
          return null;
        }

        const text = await res.text();
        let parsed: unknown;

        try {
          parsed = JSON.parse(text);
        } catch {
          return formatDecisionBrief(text);
        }

        return formatDecisionBrief(resultsToText(parsed));
      } catch {
        return null;
      }
    },

    async retain(content: string): Promise<void> {
      const redacted = redactForRetain(content);

      if (redacted.length === 0) {
        return;
      }

      try {
        await fetchFn(bankPath(baseUrl, bankId, "/memories"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            async: false,
            items: [{ content: redacted, context: DECISION_CONTEXT }],
          }),
        });
      } catch {
        // fail-soft
      }
    },

    async list(): Promise<readonly string[]> {
      try {
        const res = await fetchFn(bankPath(baseUrl, bankId, "/memories/list"), {
          method: "GET",
          headers: { accept: "application/json" },
        });

        if (!res.ok) {
          return [];
        }

        const text = await res.text();
        let parsed: unknown;

        try {
          parsed = JSON.parse(text);
        } catch {
          return text.trim().length > 0 ? [text.trim()] : [];
        }

        return listToTexts(parsed);
      } catch {
        return [];
      }
    },

    async forget(): Promise<void> {
      try {
        await fetchFn(bankPath(baseUrl, bankId, "/memories"), {
          method: "DELETE",
        });
      } catch {
        // fail-soft
      }
    },
  };
}
