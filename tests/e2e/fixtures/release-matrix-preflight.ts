import { chromium } from "@playwright/test";
import { resolve } from "node:path";

export default async function releaseMatrixPreflight(): Promise<void> {
  if (process.env.HALLPASS_RELEASE_MATRIX !== "1") return;
  const executablePath = process.env.HALLPASS_CHROME_PATH;
  const channel = process.env.HALLPASS_RELEASE_CHANNEL;
  if (!executablePath || (channel !== "current" && channel !== "previous")) {
    throw new Error("release-matrix-profile-invalid");
  }
  const extensionPath = resolve("apps/extension/dist/agent");
  const context = await chromium.launchPersistentContext("", {
    executablePath,
    headless: true,
    locale: process.env.HALLPASS_LOCALE === "zh-TW" ? "zh-TW" : "en-US",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--enable-unsafe-extension-debugging",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => undefined));
    if (!worker) throw new Error(`release-unpacked-load-blocked:${channel}`);
  } finally {
    await context.close();
  }
}
