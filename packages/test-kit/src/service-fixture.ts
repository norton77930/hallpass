export type PkiState = {
  thumbprint?: string;
  installedThumbprint?: string;
};

export function assertTestPkiReady(state: PkiState): { ok: boolean; reason?: string } {
  if (!state.thumbprint || !state.installedThumbprint) {
    return { ok: false, reason: "missing-thumbprint" };
  }
  if (state.thumbprint.toUpperCase() !== state.installedThumbprint.toUpperCase()) {
    return { ok: false, reason: "thumbprint-mismatch" };
  }
  return { ok: true };
}

export function assertLeafSans(input: { dns: string[]; ip: string[] }): { ok: boolean } {
  const hasLocalhost = input.dns.includes("localhost");
  const hasLoopback = input.ip.includes("127.0.0.1");
  return { ok: hasLocalhost && hasLoopback };
}

export function assertProductionRejectsTestIdentity(productionExtensionId: string, testExtensionId: string): boolean {
  return productionExtensionId.length > 0 && productionExtensionId !== testExtensionId;
}
