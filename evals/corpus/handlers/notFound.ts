export function handleNotFound(): { status: number; body: string } {
  return { status: 404, body: "not found" };
}
