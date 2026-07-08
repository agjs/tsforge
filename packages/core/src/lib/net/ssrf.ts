/**
 * SSRF guards shared by any code that fetches a URL the model or a provider
 * supplied (web_fetch, image-gen). One implementation so the private-host
 * classifier can't drift between callers. Extracted from web-fetch.ts.
 */

/** Loopback / link-local / RFC-1918 IPv4 (+ localhost) — blocked so a supplied
 *  URL can't reach the host's cloud-metadata endpoint or poke internal services.
 *  Applied to BOTH literal URL hosts and DNS-resolved IPs (same classifier). */
const PRIVATE_HOST_RE =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();

  if (host === "::1" || host === "::" || PRIVATE_HOST_RE.test(host)) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:…) — blocked wholesale. The URL parser canonicalizes
  // the embedded v4 to hex (::ffff:127.0.0.1 → ::ffff:7f00:1), so matching dotted
  // decimal is unreliable; mapped addresses have no legitimate use here and are a
  // known SSRF evasion, so reject the whole prefix.
  if (host.startsWith("::ffff:")) {
    return true;
  }

  // IPv6 unique-local (fc00::/7 → fc.. / fd..) and link-local (fe80::/10).
  return (
    /^f[cd][0-9a-f]{0,2}:/u.test(host) || /^fe[89ab][0-9a-f]?:/u.test(host)
  );
}

/** Parse + vet a fetch target: absolute http(s) only, public host only. Returns
 *  the URL or null (never throws) so the caller can reject cleanly. */
export function validateFetchUrl(raw: string): URL | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (isPrivateHost(url.hostname)) {
    return null;
  }

  return url;
}

/** Resolve a hostname to its IP addresses. Injected so tests stay offline. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export const realResolve: ResolveHost = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true });

  return records.map((r) => r.address);
};

/**
 * Reject a host that RESOLVES to a private/loopback/link-local IP, even when the
 * hostname string looks public. Wildcard-DNS services (`127-0-0-1.sslip.io`,
 * `foo.127.0.0.1.nip.io`) defeat a string-only check; this resolves the name and
 * re-runs the SAME IP classifier on every returned address.
 *
 * Residual: DNS rebinding (TOCTOU between this lookup and the runtime's own
 * connect) is not fully closed without pinning the IP and connecting to it with a
 * Host header — out of scope; this closes the wildcard-DNS / public-name class.
 */
export async function assertPublicResolution(
  url: URL,
  resolve: ResolveHost = realResolve
): Promise<void> {
  let addresses: readonly string[];

  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw new Error(`could not resolve host (${url.hostname})`);
  }

  if (addresses.length === 0) {
    throw new Error(`host did not resolve (${url.hostname})`);
  }

  const priv = addresses.find((ip) => isPrivateHost(ip));

  if (priv !== undefined) {
    throw new Error(
      `blocked a host resolving to a private address (${url.hostname} → ${priv})`
    );
  }
}
