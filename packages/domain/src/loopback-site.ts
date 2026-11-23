/**
 * 043 R-582, FR-623, D-043-5: whether a site is the owner's own machine, for the `evaluate` effect
 * question's "this session" (D-043-3).
 *
 * Exactly three hosts: `localhost`, `127.0.0.1` and `[::1]`, on any port, over http or https. The
 * input is parsed, so a form the URL parser normalises to one of them (`http://127.1`,
 * `http://LOCALHOST`) counts: it is the same canonical origin Chrome keys the site under. Anything
 * else is not loopback - a subdomain of `localhost`, a trailing dot, the rest of `127.0.0.0/8`, an
 * IPv4-mapped IPv6 address, a public name that contains or resolves to one of the three - and so is a
 * string that does not parse. Never throws.
 *
 * Deliberately narrower than `isLoopbackOrigin` in the extension's `agent-tools/transitions.ts`,
 * which serves the 014 transition rule and accepts all of `127.0.0.0/8`.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackSite(site: string): boolean {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}
