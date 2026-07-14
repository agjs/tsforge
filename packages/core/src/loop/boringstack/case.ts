/** Convert PascalCase name to camelCase (first char lowercased). */
export function toCamelCase(pascalName: string): string {
  return pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
}
