/** PascalCase → camelCase (first char lowercased). Matches the template generators. */
export function toCamelCase(pascalName: string): string {
  return pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
}

/** PascalCase → kebab-case for content schema files (`Coin` → `coin`, `ShopItem` → `shop-item`). */
export function toKebabCase(pascalName: string): string {
  return pascalName
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

/** Scene key id `World` or `WorldScene` → folder/class `WorldScene`. */
export function sceneFolder(scene: string): string {
  return scene.endsWith("Scene") ? scene : `${scene}Scene`;
}
