export function handleHealth(): { status: number; body: string } {
  return { status: 200, body: "ok" };
}
