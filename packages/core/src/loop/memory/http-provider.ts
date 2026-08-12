import { isArray, isRecord } from "../../lib/guards";
import { redactForRetain } from "./redact";
import { formatDecisionBrief } from "./format-brief";
import { trace } from "../../lib/trace";
import {
  DECISION_CONTEXT,
  DECISION_RECALL_QUERY,
  MEMORY_REQUEST_TIMEOUT_MS,
  type IMemoryProvider,
} from "./provider.types";

export type IHttpMemoryFetch = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    /** Abort signal — the caller always supplies one; see `withTimeout`. */
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Every request carries a deadline. try/catch alone is fail-soft against errors
 * but NOT against slowness: a backend that accepts the connection and never
 * answers would otherwise hang the caller forever — and `recall` runs before
 * the session starts, so that hangs the whole CLI with no output.
 */
function withTimeout(): AbortSignal {
  return AbortSignal.timeout(MEMORY_REQUEST_TIMEOUT_MS);
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
      const res = await fetchFn(bankPath(baseUrl, bankId, "/memories/recall"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: query.length > 0 ? query : DECISION_RECALL_QUERY,
          max_tokens: 800,
          budget: "low",
        }),
        signal: withTimeout(),
      });

      if (!res.ok) {
        // Throw so loaders can distinguish backend failure from an empty bank.
        throw new Error(`memory recall HTTP ${res.status}`);
      }

      const text = await res.text();
      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch {
        return formatDecisionBrief(text);
      }

      return formatDecisionBrief(resultsToText(parsed));
    },

    async retain(content: string): Promise<boolean> {
      const redacted = redactForRetain(content);

      if (redacted.length === 0) {
        return true;
      }

      try {
        const res = await fetchFn(bankPath(baseUrl, bankId, "/memories"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // `async: true` — queue the write and return, do NOT wait for the
            // backend to extract facts from it.
            //
            // Extraction is an LLM round-trip on the backend's side. Measured
            // against Hindsight with a realistic ~550-char decision:
            //   async: false -> 3.4-4.3s      async: true -> 0.03-0.05s
            //
            // Two things broke with the synchronous form. It is awaited inside
            // drive(), so every green send paid the full extraction latency
            // before returning to the user. And it exceeds this provider's
            // request deadline, so real retains were aborted mid-flight and
            // silently lost — the failure looked exactly like a working setup
            // that simply never remembered anything.
            async: true,
            items: [{ content: redacted, context: DECISION_CONTEXT }],
          }),
          signal: withTimeout(),
        });

        // Fail-soft, but not silent: a backend that rejects every write is
        // otherwise undetectable — nothing throws and nothing is stored.
        if (!res.ok) {
          trace("memory.http.retain", `status ${res.status}`);

          return false;
        }

        return true;
      } catch (err) {
        trace("memory.http.retain", err);

        return false;
      }
    },

    async list(): Promise<readonly string[]> {
      try {
        const res = await fetchFn(bankPath(baseUrl, bankId, "/memories/list"), {
          method: "GET",
          headers: { accept: "application/json" },
          signal: withTimeout(),
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
        const res = await fetchFn(bankPath(baseUrl, bankId, "/memories"), {
          method: "DELETE",
          signal: withTimeout(),
        });

        if (!res.ok) {
          trace("memory.http.forget", `status ${res.status}`);
        }
      } catch (err) {
        trace("memory.http.forget", err);
      }
    },
  };
}
