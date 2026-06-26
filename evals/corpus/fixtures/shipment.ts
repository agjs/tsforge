import type { IEntity } from "./types";

export function makeShipment(): IEntity {
  return { id: "shipment-1", kind: "shipment" };
}
