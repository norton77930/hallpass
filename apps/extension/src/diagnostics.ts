export function reportTestDiagnostic(code: string): void {
  const mode = (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
  if (mode === "test" || mode === "development") {
    console.warn(`[hallpass] ${code}`);
  }
}
