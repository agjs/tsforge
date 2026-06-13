import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import mermaid from "astro-mermaid";
import remarkGfm from "remark-gfm";

function rehypeAccessibleTables() {
  return (tree) => {
    const visit = (node, parent, index) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "element" &&
        node.tagName === "table" &&
        parent &&
        !(
          parent.type === "element" &&
          parent.tagName === "div" &&
          parent.properties?.role === "region"
        )
      ) {
        const wrapper = {
          type: "element",
          tagName: "div",
          properties: {
            role: "region",
            "aria-label": "Scrollable table",
            tabIndex: 0,
            className: ["tf-table-scroll"],
          },
          children: [node],
        };
        parent.children[index] = wrapper;
        return;
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          visit(node.children[i], node, i);
        }
      }
    };
    visit(tree, null, 0);
  };
}

export default defineConfig({
  site: "https://tsforge.dev",
  output: "static",

  markdown: {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeAccessibleTables],
  },

  integrations: [
    sitemap(),
    react(),
    mermaid({
      theme: "base",
      autoTheme: true,
      mermaidConfig: {
        look: "classic",
        flowchart: { curve: "basis", padding: 26, useMaxWidth: true },
        themeVariables: {
          background: "transparent",
          primaryColor: "rgba(59, 130, 246, 0.16)",
          primaryBorderColor: "#3b82f6",
          primaryTextColor: "#f1f5f9",
          lineColor: "#60a5fa",
          textColor: "#f1f5f9",
          fontFamily:
            "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        },
      },
    }),
    starlight({
      title: "tsforge",
      description:
        "TypeScript coding harness with a deterministic gate, stack-aware guardrails, and stream-level correction.",
      favicon: "/favicon.svg",
      customCss: [
        "./src/styles/tailwind.css",
        "./src/styles/custom.css",
        "./src/styles/landing.css",
      ],
      tableOfContents: false,
      components: {
        Footer: "./src/components/Footer.astro",
        Header: "./src/components/Header.astro",
        Hero: "./src/components/LandingHero.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Pagination: "./src/components/Pagination.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
      },
      head: [
        {
          tag: "meta",
          attrs: { property: "og:type", content: "website" },
        },
        {
          tag: "meta",
          attrs: { property: "og:site_name", content: "tsforge" },
        },
        {
          tag: "meta",
          attrs: { property: "og:url", content: "https://tsforge.dev/" },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/agjs/tsforge",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/agjs/tsforge/edit/main/apps/docs/",
      },
      lastUpdated: true,
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Welcome", link: "/" },
            { label: "Quickstart", link: "/quickstart/" },
            { label: "Big picture", link: "/big-picture/" },
            { label: "Interactive CLI", link: "/cli/interactive/" },
          ],
        },
        {
          label: "Loop",
          items: [
            { label: "How the gate is built", link: "/loop/gate-floor/" },
            { label: "When the gate fails", link: "/loop/validation/" },
            { label: "Spec format", link: "/spec/format/" },
            { label: "Spec runner", link: "/loop/spec-runner/" },
            { label: "Model agent", link: "/agent/model-agent/" },
            { label: "File ops", link: "/edit/engine/" },
            { label: "Plan mode", link: "/cli/plan-mode/" },
          ],
        },
        {
          label: "TypeScript LSP",
          items: [
            { label: "Language server", link: "/lsp/typescript-server/" },
            { label: "Write diagnostics", link: "/uplift/write-diagnostics/" },
          ],
        },
        {
          label: "Web scaffolding",
          items: [{ label: "Vite stacks", link: "/scaffold/web/" }],
        },
        {
          label: "Guardrails",
          items: [
            { label: "Stack detection", link: "/guardrails/stack-detection/" },
            { label: "Rule packs", link: "/guardrails/rule-packs/" },
            { label: "Meta-rules", link: "/guardrails/meta-rules/" },
            { label: "tsforge.config.json", link: "/guardrails/config/" },
          ],
        },
        {
          label: "Helping the model",
          items: [
            { label: "Fix bad tool calls", link: "/uplift/repair-ladder/" },
            { label: "Safer line edits", link: "/uplift/hashline/" },
            { label: "Stop bad output early", link: "/uplift/ttsr/" },
          ],
        },
        {
          label: "Inference",
          items: [{ label: "Model adapter", link: "/inference/adapter/" }],
        },
        {
          label: "Integrations",
          items: [{ label: "MCP servers", link: "/integrations/mcp/" }],
        },
        {
          label: "Eval",
          items: [{ label: "A/B testing", link: "/eval/ab-testing/" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Commands", link: "/reference/commands/" },
            { label: "Environment variables", link: "/reference/flags/" },
            { label: "Rule catalog", link: "/reference/rules-catalog/" },
            { label: "Roadmap", link: "/reference/roadmap/" },
          ],
        },
      ],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
    build: {
      chunkSizeWarningLimit: 700,
    },
  },
});
