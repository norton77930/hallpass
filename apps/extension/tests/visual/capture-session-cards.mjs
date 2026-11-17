// 036 T1065: captures the session-card fixture page in both locales and both colour schemes.
//
//   cd apps/extension && npx vite --mode agent --port 5288      (leave it running)
//   node tests/visual/capture-session-cards.mjs <output-dir> [port]
//
// Writes session-cards-{zh-TW,en-US}-{light,dark}.png, 360 px wide, full page, at 2x.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const outDir = process.argv[2];
const port = process.argv[3] ?? "5288";
if (outDir === undefined) {
  console.error("usage: node tests/visual/capture-session-cards.mjs <output-dir> [port]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => failures.push(String(error)));
  for (const locale of ["zh-TW", "en-US"]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://localhost:${port}/tests/visual/session-cards.html?locale=${locale}&scheme=${scheme}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-session-id]");
      await page.waitForTimeout(400);
      const file = resolve(outDir, `session-cards-${locale}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
  }
} finally {
  await browser.close();
}
if (failures.length > 0) {
  console.error(JSON.stringify(failures));
  process.exit(1);
}
