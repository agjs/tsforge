export interface IJobBlock {
  readonly name: string;
  readonly lines: readonly string[];
}

const JOB_KEY_PATTERN = /^ {2}([\w-]+):\s*(?:#.*)?$/u;

/** Collect job blocks from a GitHub Actions workflow YAML string. */
export function collectJobBlocks(text: string): IJobBlock[] {
  const lines = text.split("\n");
  const blocks: IJobBlock[] = [];
  let inJobs = false;
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (/^jobs:\s*(?:#.*)?$/u.test(line)) {
      inJobs = true;
      continue;
    }

    if (!inJobs) {
      continue;
    }

    if (/^\S/u.test(line)) {
      inJobs = false;

      if (current !== null) {
        blocks.push(current);
        current = null;
      }

      continue;
    }

    const jobMatch = JOB_KEY_PATTERN.exec(line);

    if (jobMatch?.[1] !== undefined) {
      if (current !== null) {
        blocks.push(current);
      }

      current = { name: jobMatch[1], lines: [] };
      continue;
    }

    if (current !== null) {
      current.lines.push(line);
    }
  }

  if (current !== null) {
    blocks.push(current);
  }

  return blocks;
}

/** Whether the workflow declares top-level permissions. */
export function hasWorkflowLevelPermissions(text: string): boolean {
  return /^permissions:\s*(?:#.*)?$/mu.test(text);
}

/** Extract the top-level permissions block lines (excluding the header). */
export function collectWorkflowPermissionsLines(text: string): string[] {
  const lines = text.split("\n");
  const block: string[] = [];
  let inPermissions = false;

  for (const line of lines) {
    if (/^permissions:\s*(?:#.*)?$/u.test(line)) {
      inPermissions = true;
      continue;
    }

    if (inPermissions) {
      if (/^\S/u.test(line)) {
        break;
      }

      block.push(line);
    }
  }

  return block;
}
