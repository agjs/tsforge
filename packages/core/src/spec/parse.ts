import { SPEC_MODE, type ISpec, type ITask } from "./types";

/**
 * Parse our minimal one-file spec format (see docs: /spec/format/).
 *
 * Deliberately small: enough for the walking skeleton — frontmatter keys plus a
 * `## Tasks` list where each numbered task carries indented `accept:`/`files:`
 * lines. Richer fields (needs/covers/docs) land in the spec-engine slice.
 */
export function parseSpec(markdown: string): ISpec {
  const fm = parseFrontmatter(markdown);
  const tasks = parseTasks(markdown);
  const intent = parseSection(markdown, "Acceptance criteria");

  if (intent.length > 0) {
    for (const task of tasks) {
      task.intent = intent;
    }
  }

  return {
    id: fm.id ?? "",
    title: fm.title ?? "",
    verify: fm.verify ?? "",
    tasks,
    mode:
      fm.mode === SPEC_MODE.existing ? SPEC_MODE.existing : SPEC_MODE.scratch,
  };
}

/** Return the text under a `## <heading>` block, up to the next `##` or EOF. */
function parseSection(md: string, heading: string): string {
  const out: string[] = [];
  let capturing = false;

  for (const line of md.split("\n")) {
    if (/^##\s+/.test(line)) {
      if (capturing) {
        break;
      }

      if (line.slice(2).trim().toLowerCase() === heading.toLowerCase()) {
        capturing = true;
      }

      continue;
    }

    if (capturing) {
      out.push(line);
    }
  }

  return out.join("\n").trim();
}

function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = /^---\n([\s\S]*?)\n---/.exec(md);
  const body = match?.[1];

  if (body === undefined) {
    return out;
  }

  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");

    if (idx === -1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    if (key.length > 0) {
      out[key] = val;
    }
  }

  return out;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseTasks(md: string): ITask[] {
  const tasks: ITask[] = [];
  let current: ITask | null = null;

  for (const line of md.split("\n")) {
    const start = /^(\d+)\.\s+/.exec(line);

    if (start) {
      if (current) {
        tasks.push(current);
      }

      current = { id: start[1] ?? "", accept: "", files: [], context: [] };
      continue;
    }

    if (!current) {
      continue;
    }

    const acceptMatch = /^\s+accept:\s*(.+)$/.exec(line);
    const acceptValue = acceptMatch?.[1];

    if (acceptValue !== undefined) {
      current.accept = acceptValue.trim();
      continue;
    }

    const filesMatch = /^\s+files:\s*(.+)$/.exec(line);
    const filesValue = filesMatch?.[1];

    if (filesValue !== undefined) {
      current.files = splitList(filesValue);
      continue;
    }

    const contextMatch = /^\s+context:\s*(.+)$/.exec(line);
    const contextValue = contextMatch?.[1];

    if (contextValue !== undefined) {
      current.context = splitList(contextValue);
      continue;
    }

    const fixMatch = /^\s+fix:\s*(.+)$/.exec(line);
    const fixValue = fixMatch?.[1];

    if (fixValue !== undefined) {
      current.fix = fixValue.trim();
    }
  }

  if (current) {
    tasks.push(current);
  }

  return tasks;
}
