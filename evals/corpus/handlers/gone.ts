export function handleGone(): { status: number; body: string } {
  return { status: 410, body: "gone" };
}
