/**
 * The one redactor for text the broker shows or logs that came from an agent or an installer
 * (019/R-326): an agent's error message, npm's stderr, a log line. Stderr as a whole is never shown
 * by default; whatever is shown passes through here first.
 *
 * It removes what could be a credential and leaves the rest readable - paths, versions, package
 * names, UUIDs. The replacement is always `[redacted]`, which none of the patterns match, so
 * applying it twice (the broker log and the panel each do) changes nothing the second time.
 *
 * It is a net, not a proof: a secret in a shape none of these patterns know passes through. That is
 * why callers also keep stderr out of the panel unless it is the only explanation there is.
 */

const MARK = "[redacted]";

const TOKEN_CHARS = "A-Za-z0-9._~+/=-";

/** `scheme://user:password@host` - the credentials go, scheme and host stay. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/]*@/gi;

/** `Authorization: Bearer abc`, `authorization=Basic abc` - the whole value, scheme word included. */
const AUTHORIZATION = /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi;

/** A bare `Bearer <token>`: needs a digit or real length so the word after "Bearer" in prose stays. */
const BEARER = new RegExp(`\\b(bearer\\s+)(?:(?=[${TOKEN_CHARS}]*\\d)[${TOKEN_CHARS}]{8,}|[${TOKEN_CHARS}]{20,})`, "gi");

/** `password=x`, `GITHUB_TOKEN=x`, `?api_key=x` - queries and environment dumps. */
const KEY_VALUE = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*=)[^\s&"'#]+/gi;

/** `"password": "x"` in a JSON dump. */
const JSON_KEY_VALUE = /("[^"\\]*(?:password|passwd|secret|token|api[_-]?key)[^"\\]*"\s*:\s*")[^"]*(")/gi;

/** Vendor shapes: `sk-...`, `ghp_...`, `github_pat_...`. */
const VENDOR_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;

/** A long run of base64 / hex / url-safe characters (32 or more), with its padding. */
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redact(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1${MARK}@`)
    .replace(AUTHORIZATION, `$1${MARK}`)
    .replace(BEARER, `$1${MARK}`)
    .replace(KEY_VALUE, `$1${MARK}`)
    .replace(JSON_KEY_VALUE, `$1${MARK}$2`)
    .replace(VENDOR_KEYS, MARK)
    .replace(LONG_RUN, (run) => {
      // A run without a digit is a long kebab-case name or a path, not a secret; a UUID is an id.
      if (!/\d/.test(run) || UUID.test(run)) return run;
      // A `/` inside the run may be a URL path (`/@scope/pkg/-/pkg-1.2.3`) rather than base64:
      // those are lower-case, base64 secrets are mixed-case.
      if (run.includes("/") && !(/[a-z]/.test(run) && /[A-Z]/.test(run))) return run;
      return MARK;
    });
}

/**
 * The end of a (long) text, redacted, at most `maxChars` long: what the install error and the
 * panel show of npm's stderr. Redacts first so a secret cut by the tail boundary is still caught.
 */
export function redactedTail(text: string, maxChars: number): string {
  const clean = redact(text).trim();
  return clean.length <= maxChars ? clean : clean.slice(clean.length - maxChars);
}

/**
 * SC-161: `text` with every value of an environment variable the agent ran with replaced by the
 * variable's name, longest values first. Values shorter than eight characters are left: they are not
 * keys, and replacing them would mangle ordinary words. It catches what `redact()` cannot know is a
 * secret (a short key with no vendor prefix); callers apply `redact()` after it.
 */
export function withoutEnvironmentValues(text: string, env: Readonly<Record<string, string | undefined>>): string {
  const pairs = Object.entries(env)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length >= 8)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of pairs) out = out.split(value).join(`%${name}%`);
  return out;
}

/**
 * 024 R-387 (SC-174): a line with the user's profile folder said as `%USERPROFILE%` - either slash,
 * any case - so a copied diagnostic does not carry the account name. Applied where a run's lines are
 * kept (023 R-367), so every reply that hands them out says the same.
 */
export function withoutUserProfile(line: string, profile: string | undefined): string {
  const trimmed = profile?.replace(/[\\/]+$/u, "");
  if (trimmed === undefined || trimmed.length < 3) return line;
  const pattern = trimmed
    .split(/[\\/]+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[\\\\/]+");
  return line.replace(new RegExp(pattern, "giu"), "%USERPROFILE%");
}
