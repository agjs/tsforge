import { test, expect, describe } from "bun:test";
import {
  waitForOpenApi,
  preflightApi,
  preflightOrExit,
  resolveOpenApiUrl,
  isOpenApiSpec,
  type IHttpProbe,
  type IPreflightIo,
} from "../src/loop/boringstack/openapi-preflight";

describe("isOpenApiSpec (2xx alone is not proof)", () => {
  test("true for an OpenAPI or Swagger document with version + info + paths", () => {
    expect(isOpenApiSpec({ openapi: "3.1.0", info: {}, paths: {} })).toBe(true);
    expect(isOpenApiSpec({ swagger: "2.0", info: {}, paths: {} })).toBe(true);
  });

  test("false for a non-spec body (204/HTML/arbitrary JSON)", () => {
    expect(isOpenApiSpec(null)).toBe(false);
    expect(isOpenApiSpec("<html>not found</html>")).toBe(false);
    expect(isOpenApiSpec({ message: "ok" })).toBe(false);
  });

  test("false when the version string is present but info/paths are missing (generate:api would still fail)", () => {
    // A bare version with no `paths` (or no `info`) is not a spec the client
    // generator can consume — accepting it returns the harness to the gate failure
    // the pre-flight exists to prevent.
    expect(isOpenApiSpec({ openapi: "3.1.0" })).toBe(false);
    expect(isOpenApiSpec({ openapi: "3.1.0", info: {} })).toBe(false);
    expect(isOpenApiSpec({ openapi: "garbage" })).toBe(false);
  });
});

describe("resolveOpenApiUrl", () => {
  test("an explicit OPENAPI_URL wins", () => {
    expect(resolveOpenApiUrl("http://explicit/spec", 62306)).toBe(
      "http://explicit/spec"
    );
  });

  test("falls back to the API's published port when unset or empty", () => {
    expect(resolveOpenApiUrl(undefined, 62306)).toBe(
      "http://localhost:62306/swagger/json"
    );
    expect(resolveOpenApiUrl("", 7330)).toBe(
      "http://localhost:7330/swagger/json"
    );
  });
});

/** A virtual clock so tests never wait on real time. */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let t = 0;

  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForOpenApi", () => {
  test("returns ok once the endpoint responds (after transient failures)", async () => {
    const clock = fakeClock();
    let calls = 0;

    const probe = async (): Promise<IHttpProbe> => {
      calls += 1;

      return calls < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    };

    const r = await waitForOpenApi("http://api/swagger/json", {
      probe,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 10,
      timeoutMs: 10_000,
    });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  test("returns ok=false with the last error on timeout, never throws", async () => {
    const clock = fakeClock();

    const probe = async (): Promise<IHttpProbe> => {
      throw new Error("ECONNREFUSED");
    };

    const r = await waitForOpenApi("http://api/swagger/json", {
      probe,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 100,
      timeoutMs: 250,
    });

    expect(r.ok).toBe(false);
    expect(r.lastError).toBe("ECONNREFUSED");
    expect(r.attempts).toBeGreaterThan(0);
  });

  test("a non-OK HTTP status is reported as the last error", async () => {
    const clock = fakeClock();
    const probe = async (): Promise<IHttpProbe> => ({ ok: false, status: 404 });

    const r = await waitForOpenApi("http://api/swagger/json", {
      probe,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 100,
      timeoutMs: 0,
    });

    expect(r.ok).toBe(false);
    expect(r.lastError).toBe("HTTP 404");
    // At least one probe runs even with a zero timeout.
    expect(r.attempts).toBe(1);
  });
});

describe("preflightApi (fail-closed build guard)", () => {
  test("ok when the spec becomes reachable", async () => {
    const clock = fakeClock();
    const probe = async (): Promise<IHttpProbe> => ({ ok: true, status: 200 });

    const r = await preflightApi("http://api/swagger/json", "/tmp/clone", {
      probe,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.ok).toBe(true);

    if (r.ok) {
      expect(r.attempts).toBe(1);
    }
  });

  test("an unreachable endpoint blocks the build with an actionable message", async () => {
    const clock = fakeClock();

    const probe = async (): Promise<IHttpProbe> => {
      throw new Error("ECONNREFUSED");
    };

    const r = await preflightApi("http://api/swagger/json", "/tmp/clone", {
      probe,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 100,
      timeoutMs: 0,
    });

    expect(r.ok).toBe(false);

    if (!r.ok) {
      // Carries the URL, the fetch reason, and the exact command to bring the
      // stack up — a human (or the model's operator) can act on it immediately.
      expect(r.message).toContain("http://api/swagger/json");
      expect(r.message).toContain("ECONNREFUSED");
      expect(r.message).toContain("./dev.sh up -d --build");
      expect(r.message).toContain("/tmp/clone/infra/compose/compose");
    }
  });
});

/** A fake IO that records writes and turns exit into a throw (real exit doesn't
 *  return), so a failing pre-flight's control flow is observable in a test. */
function fakeIo(): {
  io: IPreflightIo;
  out: string[];
  err: string[];
  exits: number[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];

  const io: IPreflightIo = {
    writeOut: (text) => {
      out.push(text);
    },
    writeErr: (text) => {
      err.push(text);
    },
    exit: (code) => {
      exits.push(code);

      throw new Error(`__exit_${String(code)}__`);
    },
  };

  return { io, out, err, exits };
}

describe("preflightOrExit (fail-closed build gate)", () => {
  test("reachable → writes progress and never exits", async () => {
    const { io, out, exits } = fakeIo();
    const probe = async (): Promise<IHttpProbe> => ({ ok: true, status: 200 });

    await preflightOrExit("http://api/swagger/json", "/tmp/clone", io, {
      probe,
      now: () => 0,
      sleep: async () => undefined,
    });

    expect(exits).toEqual([]);
    expect(out.join("")).toContain("API reachable");
  });

  test("unreachable → exits(2) with the actionable message on stderr", async () => {
    const clock = fakeClock();
    const { io, err, exits } = fakeIo();

    const probe = async (): Promise<IHttpProbe> => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      preflightOrExit("http://api/swagger/json", "/tmp/clone", io, {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        intervalMs: 100,
        timeoutMs: 0,
      })
    ).rejects.toThrow("__exit_2__");

    expect(exits).toEqual([2]);
    expect(err.join("")).toContain("ECONNREFUSED");
    expect(err.join("")).toContain("./dev.sh up -d --build");
  });
});
