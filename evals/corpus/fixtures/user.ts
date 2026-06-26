import type { IEntity } from "./types";

export function makeUser(): IEntity {
  return { id: "user-1", kind: "user" };
}
