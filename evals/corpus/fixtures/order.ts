import type { IEntity } from "./types";

export function makeOrder(): IEntity {
  return { id: "order-1", kind: "order" };
}
