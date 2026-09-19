/**
 * Whether the local test TLS leaf can still serve a gate run.
 *
 * The leaf the owner installs lives for thirty days. When it lapses, every packaged case fails at the
 * same moment with `ERR_CERT_DATE_INVALID`, which is indistinguishable from a product regression
 * unless something says otherwise - on 2026-09-03 it cost a diagnosis. `npm run test:certs:verify`
 * does not catch it either, because it checks the CA rather than the leaf.
 *
 * These are pure functions so the decision can be tested without a certificate: the harness reads the
 * certificate it is actually serving and asks them what it means.
 */
export type LeafValidity = "usable" | "expiring" | "expired";

/**
 * How much of the certificate's remaining life a gate run may need. A run takes minutes, so a leaf
 * with less than a day left is reported now rather than allowed to lapse mid-run and produce the same
 * unreadable failure one test at a time.
 */
export const LEAF_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export function classifyLeafValidity(validTo: string, now: number = Date.now()): LeafValidity {
  const expiresAt = Date.parse(validTo);
  // A validity that cannot be read is not evidence that the certificate is fine.
  if (!Number.isFinite(expiresAt)) {
    return "expired";
  }
  if (expiresAt <= now) {
    return "expired";
  }
  return expiresAt - now < LEAF_EXPIRY_WARNING_MS ? "expiring" : "usable";
}

/** What the harness prints before it stops. It names the cause, the deadline, and the one fix. */
export function leafValidityMessage(state: Exclude<LeafValidity, "usable">, validTo: string): string {
  const headline =
    state === "expired"
      ? `test-pki.leaf-expired\n  the test TLS leaf expired ${validTo}`
      : `test-pki.leaf-expiring\n  the test TLS leaf expires ${validTo}, within the next day`;
  return (
    `${headline}\n` +
    "  this is an environment fault, not a product regression: every packaged case will fail\n" +
    "  together with ERR_CERT_DATE_INVALID. The test leaf is issued for thirty days.\n" +
    "  run: npm run test:certs:install   (renews the leaf; no dialog while the CA key is at hand)"
  );
}

/** Recognises the TLS error a lapsed leaf produces, so it can be reported as the same fault. */
export function isCertificateExpiryError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_CERT_DATE_INVALID/.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /certificate has expired|CERT_HAS_EXPIRED|ERR_CERT_DATE_INVALID/i.test(message);
}
