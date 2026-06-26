export function oldApi(payload: string): string {
  return payload;
}

export function newApi(payload: string, tier: string): string {
  return `${tier}:${payload}`;
}
