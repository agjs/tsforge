import type { IEntity } from "./types";

export function makeInvoice(): IEntity {
  return { id: "invoice-1", kind: "invoice" };
}
