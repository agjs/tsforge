export function isHexColor(v: string): boolean {
  return /^#?[0-9a-f]{6}$/iu.test(v);
}
