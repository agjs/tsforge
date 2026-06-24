import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveLocalModule,
  readExportedNames,
  missingExportHint,
  buildExportIndex,
  unresolvedNameHint,
  selfSpecifier,
} from "../src/files/module-exports";

describe("readExportedNames", () => {
  test("extracts named declarations and export lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-exports-"));

    try {
      const file = join(dir, "shared.types.ts");

      await writeFile(
        file,
        [
          "export type OrganizationId = string;",
          "export interface IResult<T> { ok: boolean; value: T; }",
          "export const ROLES = ['admin'] as const;",
          "export function helper(): void {}",
          "const internal = 1;",
          "export { internal as exposed };",
        ].join("\n")
      );

      const names = readExportedNames(file);

      expect(names).toContain("OrganizationId");
      expect(names).toContain("IResult");
      expect(names).toContain("ROLES");
      expect(names).toContain("helper");
      expect(names).toContain("exposed"); // `as`-renamed export
      expect(names).not.toContain("internal"); // the local name is not exported
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable file → empty", () => {
    expect(readExportedNames("/no/such/file.ts")).toEqual([]);
  });
});

describe("resolveLocalModule", () => {
  test("resolves @/ alias and relative specifiers, rejects packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-resolve-"));

    try {
      await mkdir(join(dir, "src/shared"), { recursive: true });
      await writeFile(join(dir, "src/shared/shared.types.ts"), "export {};");
      await mkdir(join(dir, "src/features"), { recursive: true });
      const from = join(dir, "src/features/org.ts");

      expect(resolveLocalModule(from, "@/shared/shared.types", dir)).toBe(
        join(dir, "src/shared/shared.types.ts")
      );
      expect(resolveLocalModule(from, "../shared/shared.types", dir)).toBe(
        join(dir, "src/shared/shared.types.ts")
      );
      expect(resolveLocalModule(from, "react", dir)).toBeNull();
      expect(resolveLocalModule(from, "@/shared/nope", dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("missingExportHint", () => {
  test("appends real exports for TS2305/TS2724 on a local module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-hint-"));

    try {
      await mkdir(join(dir, "src/shared"), { recursive: true });
      await writeFile(
        join(dir, "src/shared/shared.types.ts"),
        "export type OrganizationId = string;\nexport type UserId = string;\n"
      );
      const from = join(dir, "src/features/org.ts");

      const hint = missingExportHint(
        2305,
        `Module '"@/shared/shared.types"' has no exported member 'BrandedId'.`,
        from,
        dir
      );

      expect(hint).toContain("OrganizationId");
      expect(hint).toContain("UserId");
      expect(hint).toContain("@/shared/shared.types exports:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no hint for unrelated codes or package imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-hint2-"));

    try {
      // Wrong code → no hint.
      expect(
        missingExportHint(2304, "Cannot find name 'x'.", join(dir, "a.ts"), dir)
      ).toBe("");
      // Package import → no hint.
      expect(
        missingExportHint(
          2305,
          `Module '"react"' has no exported member 'Nope'.`,
          join(dir, "a.ts"),
          dir
        )
      ).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildExportIndex + unresolvedNameHint (TS2304)", () => {
  test("suggests the import for a name exported elsewhere in src/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-idx-"));

    try {
      await mkdir(join(dir, "src/features/users"), { recursive: true });
      await writeFile(
        join(dir, "src/features/users/users.types.ts"),
        "export interface IUser { id: string; }\nexport type UserRole = 'admin' | 'rep';\n"
      );
      await mkdir(join(dir, "src/shared"), { recursive: true });
      await writeFile(
        join(dir, "src/shared/shared.types.ts"),
        "export type OrganizationId = string;\n"
      );

      const index = buildExportIndex(dir);

      expect(index.get("IUser")).toEqual(["@/features/users/users.types"]);
      expect(index.get("OrganizationId")).toEqual(["@/shared/shared.types"]);

      const hint = unresolvedNameHint(
        2304,
        "Cannot find name 'IUser'.",
        index,
        null
      );

      expect(hint).toContain(
        'add: import { IUser } from "@/features/users/users.types"'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no self-import suggestion, and no hint for unknown names / wrong code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-idx2-"));

    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src/thing.ts"),
        "export const Thing = 1;\n"
      );

      const index = buildExportIndex(dir);
      const self = selfSpecifier(join(dir, "src/thing.ts"), dir);

      // The file that defines `Thing` must not be told to import it from itself.
      expect(
        unresolvedNameHint(2304, "Cannot find name 'Thing'.", index, self)
      ).toBe("");
      // A name nothing exports → no hint.
      expect(
        unresolvedNameHint(2304, "Cannot find name 'Nope'.", index, null)
      ).toBe("");
      // Wrong code → no hint.
      expect(
        unresolvedNameHint(2305, "Cannot find name 'Thing'.", index, null)
      ).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists multiple modules when a name is ambiguous", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-idx3-"));

    try {
      await mkdir(join(dir, "src/a"), { recursive: true });
      await mkdir(join(dir, "src/b"), { recursive: true });
      await writeFile(join(dir, "src/a/x.ts"), "export const Dup = 1;\n");
      await writeFile(join(dir, "src/b/y.ts"), "export const Dup = 2;\n");

      const index = buildExportIndex(dir);
      const hint = unresolvedNameHint(
        2304,
        "Cannot find name 'Dup'.",
        index,
        null
      );

      expect(hint).toContain("Dup is exported by:");
      expect(hint).toContain("@/a/x");
      expect(hint).toContain("@/b/y");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
