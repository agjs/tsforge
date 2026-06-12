import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

// Default Starlight theme for now — we theme later (see north star, "work backwards").
// The structure here intentionally mirrors boringstack/apps/docs so the two feel
// like siblings; the brand chrome (mermaid neon theme, OG images, Cloudflare) is
// deliberately omitted until we need it.
export default defineConfig({
  site: "https://tsforge.dev",
  output: "static",

  integrations: [
    sitemap(),
    starlight({
      title: "tsforge",
      description:
        "A specialized local AI coding harness for TypeScript web development, built around Qwen3.6-27B. This site is our living understanding of the harness.",
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: true,
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Welcome", link: "/" },
            { label: "North star", link: "/vision/north-star/" },
          ],
        },
        {
          label: "Spec model",
          items: [{ label: "Minimal spec format", link: "/spec/format/" }],
        },
        {
          label: "Implement loop",
          items: [
            { label: "Per-chunk loop (draft)", link: "/loop/implement/" },
            { label: "Walking skeleton (built)", link: "/loop/skeleton/" },
            { label: "Validation engine (built)", link: "/loop/validation/" },
            { label: "Spec runner (built)", link: "/loop/spec-runner/" },
            { label: "Observability (built)", link: "/loop/observability/" },
          ],
        },
        {
          label: "Guardrails",
          items: [
            { label: "Rule packs (built)", link: "/guardrails/rule-packs/" },
            { label: "Meta-rules (built)", link: "/guardrails/meta-rules/" },
            { label: "tsforge.config.json (built)", link: "/guardrails/config/" },
          ],
        },
        {
          label: "Local-model uplift",
          items: [
            { label: "Repair ladder (built)", link: "/uplift/repair-ladder/" },
            { label: "Hashline edits (built)", link: "/uplift/hashline/" },
            { label: "TTSR (built)", link: "/uplift/ttsr/" },
            { label: "Write diagnostics (built)", link: "/uplift/write-diagnostics/" },
          ],
        },
        {
          label: "Inference",
          items: [{ label: "Model adapter (built)", link: "/inference/adapter/" }],
        },
        {
          label: "File ops",
          items: [{ label: "edit + create (built)", link: "/edit/engine/" }],
        },
        {
          label: "Agent",
          items: [{ label: "ModelAgent (built)", link: "/agent/model-agent/" }],
        },
        {
          label: "Eval",
          items: [{ label: "A/B testing (built)", link: "/eval/ab-testing/" }],
        },
        {
          label: "Reference",
          items: [{ label: "TSFORGE_* flags (built)", link: "/reference/flags/" }],
        },
      ],
    }),
  ],
});
