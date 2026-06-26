export function handlePing(): { status: number; body: string } {
  return { status: 200, body: "pong" };
}
