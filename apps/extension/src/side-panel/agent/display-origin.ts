/**
 * 017 follow-up: IDN origins shown as punycode.
 *
 * Every origin the panel shows comes from `URL.origin`, which spells an internationalised host in its
 * ASCII (punycode) form - `https://xn--r8jz45g.jp` - that the owner cannot read when deciding consent.
 * Showing only the Unicode form would be worse: a look-alike host (a Cyrillic "а" in "аpple.com")
 * would read as the real one. So a host with any `xn--` label is shown in both forms, the Unicode host
 * first and the ASCII host in parentheses; a host without one, or one that does not decode, is shown
 * exactly as given.
 *
 * Display only: the store, the gate, command payloads, React keys and data attributes keep the
 * canonical ASCII origin. The decoder is written from RFC 3492 (Node's `punycode` and
 * `url.domainToUnicode` are not in the panel bundle).
 */

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = "-";
const MAXINT = 0x7fffffff;

// No "@" in the host: user-info shaped input is not an origin and is shown as given.
const ORIGIN = /^([a-z][a-z0-9+.-]*:\/\/)([^/:?#@\s[\]]+)(:\d+)?$/i;

/** Controls, format (bidi, zero-width) and space characters: never shown as part of a host. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Z}]/u;

export function displayOrigin(origin: string): string {
  const match = ORIGIN.exec(origin);
  if (match === null) return origin;
  const scheme = match[1] as string;
  const host = match[2] as string;
  const port = match[3] ?? "";
  const labels = host.split(".");
  if (!labels.some(isALabel)) return origin;
  const shown: string[] = [];
  for (const label of labels) {
    if (!isALabel(label)) {
      shown.push(label);
      continue;
    }
    const decoded = decodeLabel(label.slice(4));
    if (decoded === undefined) return origin;
    shown.push(decoded);
  }
  return `${scheme}${shown.join(".")}${port} (${host})`;
}

function isALabel(label: string): boolean {
  return label.slice(0, 4).toLowerCase() === "xn--";
}

/** RFC 3492 §6.1. */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

/** RFC 3492 §5: a-z/A-Z are 0-25, 0-9 are 26-35; anything else is not a digit. */
function digitOf(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}

/**
 * RFC 3492 §6.2, with its overflow checks. Undefined on any failure, and also when the result holds
 * no non-ASCII code point (such a label is not a valid A-label), is not a valid Unicode scalar, or
 * holds a control, format or space character (it could hide or reorder what the owner reads).
 */
function decodeLabel(input: string): string | undefined {
  if (input.length === 0) return undefined;
  const output: number[] = [];
  const b = input.lastIndexOf(DELIMITER);
  for (let j = 0; j < Math.max(b, 0); j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return undefined;
    output.push(code);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  let index = b > 0 ? b + 1 : 0;
  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return undefined;
      const digit = digitOf(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) return undefined;
      if (digit > Math.floor((MAXINT - i) / w)) return undefined;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAXINT / (BASE - t))) return undefined;
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAXINT - n) return undefined;
    n += Math.floor(i / out);
    i %= out;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
    output.splice(i, 0, n);
    i += 1;
  }
  if (!output.some((code) => code >= 0x80)) return undefined;
  const decoded = String.fromCodePoint(...output);
  return UNSHOWABLE.test(decoded) ? undefined : decoded;
}
