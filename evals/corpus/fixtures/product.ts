import type { IEntity } from "./types";

export function makeProduct(): IEntity {
  return { id: "product-1", kind: "product" };
}
