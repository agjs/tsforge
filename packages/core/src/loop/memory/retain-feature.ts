import { loadTsforgeConfig } from "../../config/tsforge-config";
import { buildDecisionRetainText } from "./format-brief";
import { createMemoryProvider } from "./create-provider";
import { trace } from "../../lib/trace";

/**
 * Best-effort retain when a greenfield feature goes green. Loads project config,
 * opens the configured provider, retains, and never throws.
 *
 * @returns whether a retain was attempted and reported success.
 */
export async function retainFeatureDecision(
  cwd: string,
  featureId: string,
  featureDesc: string
): Promise<boolean> {
  try {
    const config = await loadTsforgeConfig(cwd);
    const provider = await createMemoryProvider(
      cwd,
      config.providers?.memory,
      null
    );

    if (provider === null) {
      return false;
    }

    // MCP decision memory needs a live registry; greenfield HTTP path works here.
    // MCP users still get retain from interactive Session sends.
    const text = buildDecisionRetainText({
      kind: "feature",
      summary: `${featureId} — ${featureDesc}`,
    });

    if (text === null) {
      return false;
    }

    const ok = await provider.retain(text);

    if (!ok) {
      trace(
        "memory.retain-feature",
        `retain failed for ${featureId} in bank ${provider.bankId}`
      );
    }

    return ok;
  } catch (err) {
    trace("memory.retain-feature", err);

    return false;
  }
}
