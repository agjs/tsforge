import { expect, test } from "bun:test";
import { makeInvoice } from "./invoice";
import { makeOrder } from "./order";
import { makePayment } from "./payment";
import { makeProduct } from "./product";
import { makeShipment } from "./shipment";
import type { IEntity } from "./types";
import { makeUser } from "./user";

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
