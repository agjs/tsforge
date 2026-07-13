import { describe, expect, test } from "bun:test";
import {
  PORT_ENV_KEYS,
  DEFAULT_HOST_PORTS,
  allocateHostPorts,
  parseHostPortsEnv,
  hostPortOr,
  remapUrlToHostPorts,
} from "../src/scaffold/ports";

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

describe("DEFAULT_HOST_PORTS", () => {
  test("has an upstream default for every allocated key", () => {
    for (const key of PORT_ENV_KEYS) {
      expect(DEFAULT_HOST_PORTS[key]).toBeGreaterThan(0);
    }
  });
});

describe("parseHostPortsEnv", () => {
  test("reads the port bindings tsforge wrote, ignoring other env + junk", () => {
    const env = [
      "# a comment",
      "POSTGRES_HOST_PORT=52001",
      "API_HOST_PORT=52002",
      "UI_HOST_PORT = 52003 ", // whitespace tolerated
      "SUPERUSER_EMAIL=admin@x.io", // not a port key → ignored
      "GARBAGE",
      "VALKEY_HOST_PORT=notaport", // non-numeric → dropped
      "GRAFANA_HOST_PORT=-5", // non-positive → dropped
    ].join("\n");

    const ports = parseHostPortsEnv(env);

    expect(ports.POSTGRES_HOST_PORT).toBe(52001);
    expect(ports.API_HOST_PORT).toBe(52002);
    expect(ports.UI_HOST_PORT).toBe(52003);
    expect(ports.VALKEY_HOST_PORT).toBeUndefined();
    expect(ports.GRAFANA_HOST_PORT).toBeUndefined();
    expect(Object.keys(ports)).not.toContain("SUPERUSER_EMAIL");
  });

  test("empty content yields an empty map (unconfigured clone)", () => {
    expect(parseHostPortsEnv("")).toEqual({});
  });
});

describe("hostPortOr", () => {
  test("returns the allocated port when present, else the upstream default", () => {
    expect(hostPortOr({ API_HOST_PORT: 52002 }, "API_HOST_PORT")).toBe(52002);
    expect(hostPortOr({}, "API_HOST_PORT")).toBe(
      DEFAULT_HOST_PORTS.API_HOST_PORT
    );
    expect(hostPortOr({}, "POSTGRES_HOST_PORT")).toBe(5432);
  });
});

describe("remapUrlToHostPorts", () => {
  test("swaps a default port for this project's allocated port", () => {
    const ports = { API_HOST_PORT: 52002, UI_HOST_PORT: 52003 };

    expect(
      remapUrlToHostPorts("http://localhost:7330/swagger/json", ports)
    ).toBe("http://localhost:52002/swagger/json");
    expect(remapUrlToHostPorts("http://localhost:7331/", ports)).toBe(
      "http://localhost:52003/"
    );
  });

  test("7331 maps to UI_HOST_PORT, not UI_PREVIEW_HOST_PORT (list order)", () => {
    // Both share default 7331; the health check means the UI dev server.
    const ports = { UI_HOST_PORT: 60001, UI_PREVIEW_HOST_PORT: 60002 };

    expect(remapUrlToHostPorts("http://localhost:7331/", ports)).toBe(
      "http://localhost:60001/"
    );
  });

  test("leaves a URL unchanged when the port has no allocation or no match", () => {
    // API not allocated → default port stays.
    expect(remapUrlToHostPorts("http://localhost:7330/swagger/json", {})).toBe(
      "http://localhost:7330/swagger/json"
    );
    // Port matches no known default → untouched.
    expect(
      remapUrlToHostPorts("http://localhost:9999/", { API_HOST_PORT: 1 })
    ).toBe("http://localhost:9999/");
    // Not a URL → untouched.
    expect(remapUrlToHostPorts("not a url", { API_HOST_PORT: 1 })).toBe(
      "not a url"
    );
  });
});
