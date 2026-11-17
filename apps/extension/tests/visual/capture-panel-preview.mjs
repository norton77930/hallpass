// Throwaway: node capture-panel-preview.mjs <outDir> <port> <prefix> ; also sessions fixture
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
const [outDir, port, prefix, qs = ""] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("pageerror", String(e)));
  page.on("console", (m) => m.type() === "error" && console.error("console", m.text()));
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`http://localhost:${port}/tests/visual/panel-preview.html?locale=zh-TW&scheme=${scheme}${qs}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[role=tablist]");
    await page.waitForTimeout(1200);
    await page.locator(".agent-conversation-steps").first().click().catch(() => {});
    await page.waitForTimeout(300);
    const file = resolve(outDir, `${prefix}-panel-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
    await page.goto(`http://localhost:${port}/tests/visual/session-cards.html?locale=zh-TW&scheme=${scheme}`, { waitUntil: "domcontentloaded" });
    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForSelector("[data-session-id]");
    await page.waitForTimeout(400);
    const f2 = resolve(outDir, `${prefix}-sessions-${scheme}.png`);
    await page.screenshot({ path: f2, fullPage: true });
    console.log(f2);
    await page.setViewportSize({ width: 800, height: 900 });
  }
} finally {
  await browser.close();
}
