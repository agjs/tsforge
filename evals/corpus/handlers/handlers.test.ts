import { test, expect } from "bun:test";
import { handleHealth } from "./health";
import { handleVersion } from "./version";
import { handlePing } from "./ping";
import { handleTeapot } from "./teapot";
import { handleNotFound } from "./notFound";
import { handleGone } from "./gone";
import { handleCreated } from "./created";

interface IReply {
  status: number;
  body: string;
}

const cases: ReadonlyArray<[() => IReply, number, string]> = [
  [handleHealth, 200, "ok"],
  [handleVersion, 200, "v1"],
  [handlePing, 200, "pong"],
  [handleTeapot, 418, "teapot"],
  [handleNotFound, 404, "not found"],
  [handleGone, 410, "gone"],
  [handleCreated, 201, "created"],
];

for (const [handle, status, body] of cases) {
  test(`${body} handler returns ${String(status)}`, () => {
    expect(handle()).toEqual({ status, body });
  });
}
