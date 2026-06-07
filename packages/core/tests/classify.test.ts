import { test, expect } from "bun:test";
import type { IProvider } from "../src/inference";
import { classifyIntent } from "../src/classify";

function replying(content: string): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

test("maps the model's word to a TaskKind", async () => {
  expect(await classifyIntent(replying("web"), "x")).toBe("web");
  expect(await classifyIntent(replying("node"), "x")).toBe("node");
  expect(await classifyIntent(replying("existing"), "x")).toBe("existing");
  expect(await classifyIntent(replying("chat"), "x")).toBe("chat");
});

test("tolerates extra prose; unknown defaults to chat", async () => {
  expect(await classifyIntent(replying("This is a web app."), "x")).toBe("web");
  expect(await classifyIntent(replying("I'm not sure"), "x")).toBe("chat");
});
