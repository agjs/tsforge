import { loadTsforgeConfig } from "../../config/tsforge-config";
import { buildDecisionRetainText } from "./format-brief";
import { createMemoryProvider } from "./create-provider";

/**
 * Best-effort retain when a greenfield feature goes green. Loads project config,
 * opens the configured provider, retains, and never throws.
 */
export async function retainFeatureDecision(
  cwd: string,
  featureId: string,
  featureDesc: string
): Promise<void> {
  try {
    const config = await loadTsforgeConfig(cwd);
    const provider = await createMemoryProvider(
      cwd,
      config.providers?.memory,
      null
    );

    if (provider === null) {
      return;
    }

    // MCP decision memory needs a live registry; greenfield HTTP path works here.
    // MCP users still get retain from interactive Session sends.
    const text = buildDecisionRetainText({
      kind: "feature",
      summary: `${featureId} — ${featureDesc}`,
    });

    if (text === null) {
      return;
    }

    await provider.retain(text);
  } catch {
    // fail-soft
  }
}
