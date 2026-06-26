export function isEmail(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(v);
}
