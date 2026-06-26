import { join } from "node:path";
import { isRecord } from "../../lib/guards";
import { reject, str, type IToolContext } from "./tool-context";
import { parsePackageSpecs } from "./add-dependency";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_MAX_CHARS = 12_000;
const MAX_ALLOWED_CHARS = 48_000;

export interface IPackageFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface IPackageInfoDeps {
  fetchFn: (url: string) => Promise<IPackageFetchResponse>;
}

interface IPackageDocHit {
  source: "local" | "registry";
  content: string;
}

function registryRoot(): string {
  const configured =
    process.env.TSFORGE_NPM_REGISTRY?.trim() ??
    process.env.NPM_CONFIG_REGISTRY?.trim() ??
    process.env.npm_config_registry?.trim() ??
    "";

  return (configured.length > 0 ? configured : DEFAULT_REGISTRY).replace(
    /\/+$/u,
    ""
  );
}

function singlePackageSpec(raw: string): string | null {
  const specs = parsePackageSpecs(raw);

  if (specs?.length !== 1) {
    return null;
  }

  return specs[0] ?? null;
}

function firstNonEmpty(left: string, right: string): string {
  return left.length > 0 ? left : right;
}

export function packageNameFromSpec(raw: string): string | null {
  const spec = singlePackageSpec(raw);

  if (spec === null) {
    return null;
  }

  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");

    if (slash === -1) {
      return null;
    }

    const versionAt = spec.indexOf("@", slash + 1);

    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }

  const versionAt = spec.indexOf("@");

  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function versionFromSpec(raw: string): string | null {
  const spec = singlePackageSpec(raw);

  if (spec === null) {
    return null;
  }

  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");

    if (slash === -1) {
      return null;
    }

    const versionAt = spec.indexOf("@", slash + 1);

    return versionAt === -1 ? null : spec.slice(versionAt + 1);
  }

  const versionAt = spec.indexOf("@");

  return versionAt === -1 ? null : spec.slice(versionAt + 1);
}

function registryUrl(packageName: string): string {
  return `${registryRoot()}/${encodeURIComponent(packageName)}`;
}

function stringProp(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  return typeof value === "string" ? value : "";
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function numericParts(version: string): number[] {
  const main = version.split("+")[0]?.split("-")[0] ?? "";

  return main.split(".").map((part) => {
    const n = Number.parseInt(part, 10);

    return Number.isFinite(n) ? n : 0;
  });
}

function comparePrerelease(a: string, b: string): number {
  // A release with no prerelease tag outranks any prerelease (1.0.0 > 1.0.0-rc).
  const aPre = a.split("+")[0]?.split("-").slice(1).join("-") ?? "";
  const bPre = b.split("+")[0]?.split("-").slice(1).join("-") ?? "";

  if (aPre === bPre) {
    return 0;
  }

  if (aPre.length === 0) {
    return 1;
  }

  if (bPre.length === 0) {
    return -1;
  }

  return aPre < bPre ? -1 : 1;
}

/** Ascending semver order. npm's `versions` object has no guaranteed key order,
 *  and a plain lexical sort misorders releases (1.2.0 < 1.10.0 numerically but
 *  not as strings) — so the "recent" list and the no-dist-tag latest fallback
 *  must compare version components numerically. */
function compareVersions(a: string, b: string): number {
  const pa = numericParts(a);
  const pb = numericParts(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return comparePrerelease(a, b);
}

function sortedVersionKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort(compareVersions) : [];
}

function repositoryUrl(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.url === "string") {
    return value.url;
  }

  return "";
}

function selectedVersion(
  manifest: Record<string, unknown>,
  requested: string | null
): string {
  if (requested !== null && requested.length > 0) {
    return requested;
  }

  const tags = manifest["dist-tags"];

  if (isRecord(tags) && typeof tags.latest === "string") {
    return tags.latest;
  }

  const keys = sortedVersionKeys(manifest.versions);

  return keys[keys.length - 1] ?? "";
}

function versionRecord(
  manifest: Record<string, unknown>,
  version: string
): Record<string, unknown> | null {
  const versions = manifest.versions;

  if (!isRecord(versions)) {
    return null;
  }

  const value = versions[version];

  return isRecord(value) ? value : null;
}

function formatTags(value: unknown): string {
  if (!isRecord(value)) {
    return "(none)";
  }

  const lines: string[] = [];

  for (const key of Object.keys(value).sort()) {
    const tag = value[key];

    if (typeof tag === "string") {
      lines.push(`${key}: ${tag}`);
    }
  }

  return lines.length > 0 ? lines.join(", ") : "(none)";
}

function formatDependencyList(label: string, value: unknown): string {
  const keys = recordKeys(value);

  return keys.length > 0 ? `${label}: ${keys.join(", ")}` : `${label}: (none)`;
}

function formatPackageInfo(
  manifest: Record<string, unknown>,
  requestedVersion: string | null
): string {
  const packageName = stringProp(manifest, "name");
  const version = selectedVersion(manifest, requestedVersion);
  const details = versionRecord(manifest, version);
  const source = details ?? manifest;
  const description = firstNonEmpty(
    stringProp(source, "description"),
    stringProp(manifest, "description")
  );
  const homepage = firstNonEmpty(
    stringProp(source, "homepage"),
    stringProp(manifest, "homepage")
  );
  const repo = firstNonEmpty(
    repositoryUrl(source.repository),
    repositoryUrl(manifest.repository)
  );
  const deprecated = stringProp(source, "deprecated");
  const versions = sortedVersionKeys(manifest.versions);
  const recent = versions.slice(Math.max(0, versions.length - 12));

  return [
    `# ${packageName.length > 0 ? packageName : "(unknown package)"}`,
    `registry: ${registryRoot()}`,
    `selected: ${version.length > 0 ? version : "(unknown)"}`,
    `dist-tags: ${formatTags(manifest["dist-tags"])}`,
    description.length > 0 ? `description: ${description}` : "",
    stringProp(source, "license").length > 0
      ? `license: ${stringProp(source, "license")}`
      : "",
    homepage.length > 0 ? `homepage: ${homepage}` : "",
    repo.length > 0 ? `repository: ${repo}` : "",
    deprecated.length > 0 ? `DEPRECATED: ${deprecated}` : "",
    `versions: ${String(versions.length)} total${recent.length > 0 ? `; recent: ${recent.join(", ")}` : ""}`,
    formatDependencyList("dependencies", source.dependencies),
    formatDependencyList("peerDependencies", source.peerDependencies),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function maxChars(args: Record<string, unknown>): number {
  const value = args.maxChars;

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_ALLOWED_CHARS);
  }

  return DEFAULT_MAX_CHARS;
}

function truncate(content: string, max: number): string {
  const trimmed = content.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max)}\n\n...[truncated ${String(trimmed.length - max)} chars - raise maxChars to read more]`;
}

async function fetchManifest(
  packageName: string,
  deps: IPackageInfoDeps
): Promise<Record<string, unknown> | string> {
  const url = registryUrl(packageName);

  try {
    const res = await deps.fetchFn(url);

    if (!res.ok) {
      return `npm registry returned HTTP ${String(res.status)} for ${packageName}.`;
    }

    const json = await res.json();

    return isRecord(json) ? json : `npm registry returned malformed metadata.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    return `npm registry request failed for ${packageName}: ${message}`;
  }
}

async function realPackageFetch(url: string): Promise<IPackageFetchResponse> {
  return fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "tsforge-package-info/1.0 (+keyless)",
    },
  });
}

const DEFAULT_DEPS: IPackageInfoDeps = { fetchFn: realPackageFetch };

export async function doPackageInfo(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IPackageInfoDeps = DEFAULT_DEPS
): Promise<string> {
  const raw = str(args, "package").trim();
  const packageName = packageNameFromSpec(raw);

  if (packageName === null) {
    return reject(
      ctx,
      "package_info",
      "package_info: `package` must be one plain npm package name, optionally @versioned."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ package_info ${packageName}`,
  });

  const manifest = await fetchManifest(packageName, deps);

  if (typeof manifest === "string") {
    return `package_info: ${manifest}`;
  }

  return truncate(
    formatPackageInfo(manifest, versionFromSpec(raw)),
    maxChars(args)
  );
}

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  return file.text();
}

function nodeModulesPath(cwd: string, packageName: string): string {
  return join(cwd, "node_modules", ...packageName.split("/"));
}

async function localDocs(
  cwd: string,
  packageName: string
): Promise<IPackageDocHit | null> {
  const root = nodeModulesPath(cwd, packageName);
  const pkgText = await readIfExists(join(root, "package.json"));
  const parts: string[] = [];

  if (pkgText !== null) {
    parts.push(
      `# ${packageName} package.json`,
      "```json",
      pkgText.trim(),
      "```"
    );
  }

  for (const readme of ["README.md", "readme.md", "README", "README.txt"]) {
    const content = await readIfExists(join(root, readme));

    if (content !== null && content.trim().length > 0) {
      parts.push(`# ${packageName} ${readme}`, content.trim());
      break;
    }
  }

  if (pkgText !== null) {
    try {
      const parsed: unknown = JSON.parse(pkgText);

      if (isRecord(parsed) && typeof parsed.types === "string") {
        const types = await readIfExists(join(root, parsed.types));

        if (types !== null && types.trim().length > 0) {
          parts.push(
            `# ${packageName} ${parsed.types}`,
            "```ts",
            types.trim(),
            "```"
          );
        }
      }
    } catch {
      // Package docs are best-effort; malformed local package.json is ignored.
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return { source: "local", content: parts.join("\n\n") };
}

function docsSource(
  args: Record<string, unknown>
): "auto" | "local" | "registry" | null {
  const source = args.source;

  if (source === undefined || source === null || source === "") {
    return "auto";
  }

  if (source === "auto" || source === "local" || source === "registry") {
    return source;
  }

  return null;
}

function registryDocs(
  manifest: Record<string, unknown>,
  packageName: string,
  version: string | null
): IPackageDocHit {
  const selected = selectedVersion(manifest, version);
  const details = versionRecord(manifest, selected);
  const homepage = firstNonEmpty(
    details === null ? "" : stringProp(details, "homepage"),
    stringProp(manifest, "homepage")
  );
  const repo = firstNonEmpty(
    details === null ? "" : repositoryUrl(details.repository),
    repositoryUrl(manifest.repository)
  );
  const readme = stringProp(manifest, "readme");
  const lines = [
    `# ${packageName} docs`,
    `source: npm registry (${registryRoot()})`,
    `version: ${selected.length > 0 ? selected : "(unknown)"}`,
    homepage.length > 0 ? `homepage: ${homepage}` : "",
    repo.length > 0 ? `repository: ${repo}` : "",
    readme.length > 0 ? readme : "(registry metadata did not include a README)",
  ].filter((line) => line.length > 0);

  return { source: "registry", content: lines.join("\n\n") };
}

export async function doPackageDocs(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IPackageInfoDeps = DEFAULT_DEPS
): Promise<string> {
  const raw = str(args, "package").trim();
  const packageName = packageNameFromSpec(raw);

  if (packageName === null) {
    return reject(
      ctx,
      "package_docs",
      "package_docs: `package` must be one plain npm package name, optionally @versioned."
    );
  }

  const source = docsSource(args);

  if (source === null) {
    return reject(
      ctx,
      "package_docs",
      "package_docs: `source` must be `auto`, `local`, or `registry`."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ package_docs ${packageName}`,
  });

  if (source === "auto" || source === "local") {
    const local = await localDocs(ctx.cwd, packageName);

    if (local !== null) {
      return truncate(
        `package_docs: source=${local.source}\n\n${local.content}`,
        maxChars(args)
      );
    }

    if (source === "local") {
      return `package_docs: no local docs found for ${packageName} under node_modules.`;
    }
  }

  const manifest = await fetchManifest(packageName, deps);

  if (typeof manifest === "string") {
    return `package_docs: ${manifest}`;
  }

  const hit = registryDocs(manifest, packageName, versionFromSpec(raw));

  return truncate(
    `package_docs: source=${hit.source}\n\n${hit.content}`,
    maxChars(args)
  );
}
