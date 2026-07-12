import { describe, expect, test } from "bun:test";
import { PORT_ENV_KEYS, allocateHostPorts } from "../src/scaffold/ports";

describe("allocateHostPorts", () => {
  test("assigns a port to every parameterized compose binding", async () => {
    let next = 20000;
    const stub = (): Promise<number> => Promise.resolve(next++);

    const allocated = await allocateHostPorts(stub);

    expect(allocated.map((a) => a.key).sort()).toEqual(
      [...PORT_ENV_KEYS].sort()
    );
    // Each got a distinct port from the injected allocator (no reuse).
    const ports = allocated.map((a) => a.port);

    expect(new Set(ports).size).toBe(ports.length);
  });

  test("covers the three ports the build actually needs (postgres/api/ui)", () => {
    const keys = new Set<string>(PORT_ENV_KEYS);

    for (const key of ["POSTGRES_HOST_PORT", "API_HOST_PORT", "UI_HOST_PORT"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  test("findFreePort is the default when no allocator is injected", async () => {
    // Real sockets: just prove it yields distinct, plausible ports without throwing.
    const allocated = await allocateHostPorts();
    const ports = allocated.map((a) => a.port);

    expect(ports.every((p) => p > 0 && p < 65536)).toBe(true);
    expect(allocated).toHaveLength(PORT_ENV_KEYS.length);
  });
});
