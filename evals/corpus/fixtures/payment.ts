import type { IEntity } from "./types";

export function makePayment(): IEntity {
  return { id: "payment-1", kind: "payment" };
}
