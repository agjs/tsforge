/**
 * Detect if a file is a component file (.tsx with uppercase name, not test/story)
 */
export function isComponentFile(filename: string): boolean {
  if (!filename.endsWith(".tsx")) {
    return false;
  }

  if (filename.includes(".test.tsx") || filename.includes(".stories.tsx")) {
    return false;
  }

  const basename = getBasename(filename);

  return /^[A-Z]/.test(basename);
}

/**
 * Detect if a file is a story file
 */
export function isStoryFile(filename: string): boolean {
  return filename.includes(".stories.tsx");
}

/**
 * Detect if path is in shadcn/ui components folder
 */
export function isInShadcnUi(filename: string): boolean {
  return filename.includes("/components/ui/");
}

/**
 * Extract component name from filename (e.g., Button.tsx → Button)
 */
export function getComponentName(filename: string): string | null {
  const basename = getBasename(filename);
  const match = /^([A-Z][a-zA-Z0-9]*)\.tsx$/.exec(basename);

  return match ? (match[1] ?? null) : null;
}

/**
 * Get the basename without directory
 */
function getBasename(filename: string): string {
  return filename.split("/").pop() ?? "";
}
