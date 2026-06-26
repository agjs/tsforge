import { describe, expect, test } from "bun:test";
import { parseScaffoldArgs } from "../src/scaffold/scaffold-cli";

describe("parseScaffoldArgs", () => {
  test("defaults to a full boringstack dev scaffold", () => {
    const opts = parseScaffoldArgs(["--dest", "/tmp/p"]);

    expect(opts.answers.archetype).toBe("boringstack");
    expect(opts.answers.stack).toBe("dev");
    expect(opts.dest).toBe("/tmp/p");
    expect(opts.skipBoot).toBe(false);
  });

  test("--archetype and --stack select the target", () => {
    const opts = parseScaffoldArgs([
      "--archetype",
      "astro",
      "--stack",
      "prod",
      "--dest",
      "/tmp/p",
    ]);

    expect(opts.answers.archetype).toBe("astro");
    expect(opts.answers.stack).toBe("prod");
  });

  test("--set KEY=VALUE collects single-valued answers (repeatable)", () => {
    const opts = parseScaffoldArgs([
      "--dest",
      "/tmp/p",
      "--set",
      "WITH_OBSERVABILITY=0",
      "--set",
      "EMAIL_PROVIDER=resend",
      "--set",
      "project=acme",
    ]);

    expect(opts.answers.values.WITH_OBSERVABILITY).toBe("0");
    expect(opts.answers.values.EMAIL_PROVIDER).toBe("resend");
    expect(opts.answers.values.project).toBe("acme");
  });

  test("--multi KEY=a,b collects a set-valued answer", () => {
    const opts = parseScaffoldArgs([
      "--dest",
      "/tmp/p",
      "--multi",
      "OAUTH_PROVIDERS=google,github",
    ]);

    expect(opts.answers.values.OAUTH_PROVIDERS).toEqual(["google", "github"]);
  });

  test("--no-boot sets skipBoot", () => {
    expect(parseScaffoldArgs(["--dest", "/tmp/p", "--no-boot"]).skipBoot).toBe(
      true
    );
  });

  test("rejects an unknown archetype", () => {
    expect(() =>
      parseScaffoldArgs(["--archetype", "rails", "--dest", "/tmp/p"])
    ).toThrow(/archetype/iu);
  });

  test("rejects an unknown stack", () => {
    expect(() =>
      parseScaffoldArgs(["--stack", "staging", "--dest", "/tmp/p"])
    ).toThrow(/stack/iu);
  });

  test("requires a destination", () => {
    expect(() => parseScaffoldArgs(["--archetype", "astro"])).toThrow(/dest/iu);
  });

  test("rejects a malformed --set (no =)", () => {
    expect(() =>
      parseScaffoldArgs(["--dest", "/tmp/p", "--set", "BROKEN"])
    ).toThrow(/--set/u);
  });
});
