import { test, expect } from "bun:test";
import type { IEntity } from "./types";
import { makeUser } from "./user";
import { makeOrder } from "./order";
import { makeProduct } from "./product";
import { makeInvoice } from "./invoice";
import { makePayment } from "./payment";
import { makeShipment } from "./shipment";

const cases: ReadonlyArray<[string, () => IEntity]> = [
  ["user", makeUser],
  ["order", makeOrder],
  ["product", makeProduct],
  ["invoice", makeInvoice],
  ["payment", makePayment],
  ["shipment", makeShipment],
];

for (const [kind, make] of cases) {
  test(`make ${kind} returns a tagged entity with a non-empty id`, () => {
    const e = make();

    expect(e.kind).toBe(kind);
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
  });
}
