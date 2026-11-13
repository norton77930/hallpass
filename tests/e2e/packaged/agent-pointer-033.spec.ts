import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The fixture origin, which is also the site the owner's per-site mode is keyed by (R-108). */
const SITE = "https://127.0.0.1:19443";
const MAIN_PATH = "/pointer-033";
const CSP_PATH = "/pointer-033-csp";

/** One animation frame at 60 Hz, and the slack the brief allows a frame-sampled measurement. */
const FRAME_MS = 17;
const SLACK_MS = 40;

/**
 * 033 live checks 1-6 (quickstart.md "Live"; acceptance gates live-1..live-6): the pointer says what
 * the agent is doing.
 *
 * Six tests, one per quickstart check, each writing its evidence into `testInfo.outputPath()` for a
 * person to look at: `live-N-*.json` (every measurement the assertions read, plus some that are only
 * recorded), PNG screenshots of the page as the owner sees it, and the images the tools returned to the
 * agent. A test asserts the criterion of its gate; a fact the gate only wants *known* (whether the
 * caption renders under a strict style policy, whether a navigation carries the pointer to the new
 * document, what a GIF frame holds) is recorded in the JSON and named below as such.
 *
 * How the page is watched: a probe injected into the agent's tab with Playwright (it is the runner
 * talking to the page, not the extension, and it works under a strict CSP because it arrives over CDP)
 *   - logs, in `sessionStorage` so it survives a same-origin navigation, every change of the caption's
 *     words, every mark hidden or shown for a capture, every pointer / ring / pill / glow added or
 *     removed, and the page-level mousemove / mousedown / click events with a clock;
 *   - samples the pointer's position on every animation frame, which is how travel time, curvature and
 *     "the page reacted after the pointer stopped" are measured.
 * Animation frames only run in a visible tab, so each test brings the agent's tab to the front and fails
 * with a plain sentence when it cannot be seen.
 *
 * The owner's locale is the browser's UI language: the zh-TW run needs the browser started with
 * `--lang=zh-TW` and `HALLPASS_LOCALE=zh-TW`; with neither set only the en-US words are checked.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install of
 * the native host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` of THIS checkout loaded in the attached
 * browser (reload it at chrome://extensions after a rebuild), `npm run agent-host:install`, and the
 * fixture servers (`npm run dev:test-pages`) started AFTER this change - they list the pages they were
 * started with, and `/pointer-033` and `/pointer-033-csp` are new.
 */
test.describe("agent pointer captions (spec 033)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  // ===========================================================================================
  // live-1 - one call per row of FR-499's table shows that row's caption (SC-219)
  // ===========================================================================================
  test("live-1: every FR-499 row shows its caption in the owner's language", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(600_000);
    const check = checker();
    const evidence: Record<string, unknown> = { locale, rows: [] as unknown[] };
    const rowsOut = evidence["rows"] as unknown[];

    // file_upload only reads inside the owner's upload roots (config.json in the host's data
    // directory); the original is put back in the `finally`. With the private LOCALAPPDATA of the
    // recipe this is a throw-away file.
    const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hallpass");
    const configPath = join(dataDir, "config.json");
    const savedConfig = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
    const uploadRoot = await mkdtemp(join(tmpdir(), "hallpass-033-upload-"));
    const uploadFile = join(uploadRoot, "receipt.txt");
    await writeFile(uploadFile, "pointer-033", "utf8");

    let session: Session | undefined;
    let tab: Tab | undefined;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ uploadRoots: [uploadRoot] }, null, 2), "utf8");

      session = await openSession({ extensionContext, extensionId, extensionWorker });
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;

      // The per-site diagnostics grant, so read_console / read_network / evaluate answer instead of
      // raising an owner question. Their caption is shown either way (it is put up before the call
      // runs); without the grant these three rows are skipped rather than left waiting on a card.
      let diagnosticsGranted = true;
      try {
        await session.settings.setDiagnostics(SITE, true);
      } catch (error) {
        diagnosticsGranted = false;
        note(testInfo, "diagnostics-grant", `read_console, read_network and evaluate rows skipped: ${String(error)}`);
      }
      await showTab(page);

      const ctx: RowContext = {
        tabId,
        refs: {},
        uploadFile,
        outer: await page.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight })),
      };

      const rows = captionRows();
      for (let index = 1; index < rows.length; index += 1) {
        const left = rows[index - 1]?.words?.[locale];
        const right = rows[index]?.words?.[locale];
        if (left !== undefined && left === right) throw new Error(`test table: rows ${index} and ${index + 1} share a caption`);
      }

      let previousWords: string | undefined;
      let rowNumber = 0;
      for (const row of rows) {
        rowNumber += 1;
        const label = `${String(rowNumber).padStart(2, "0")}-${row.id}`;
        if (row.needsDiagnostics === true && !diagnosticsGranted) {
          rowsOut.push({ id: row.id, skipped: "diagnostics grant not available" });
          continue;
        }
        if (row.knownHang) {
          // Measured 2026-11-13: the same call never settles on the 0.21.0 build without spec 033 either
          // (two runs, both hung here), and the tab then answers every later call `tab-in-flight`.
          rowsOut.push({ id: row.id, skipped: row.knownHang });
          test.info().annotations.push({ type: "skipped-row", description: `${row.id}: ${row.knownHang}` });
          continue;
        }
        const args = { tabId, ...row.args(ctx) };
        const expected = row.words === null ? null : row.words[locale];
        const rowStartedAt = Date.now();

        // A row that throws (an MCP timeout, a page that went away) is recorded with its tool, arguments,
        // elapsed time and message, and the loop goes on, so one run shows every row.
        try {
          const mark = await lastLogN(page);
          const before = await settle(() => page.evaluate(readPageState));
          const startedAt = Date.now();
          const result = await live.callTool(row.tool, args);
          const returnedAt = Date.now();
          if (row.replacesDocument === true) await sleep(600);
          const after = await stillPointer(page, row.mode === "unchanged" ? 0 : 450);
          const events = (await readLog(page)).filter((entry) => (entry["n"] as number) > mark);
          const wordsSeen = events.filter((e) => e["k"] === "words").map((e) => String(e["words"]));
          await saveShot(page, testInfo, `live-1-${label}.png`);
          await saveImages(testInfo, `live-1-${label}-tool`, result.images);

          const restSpot = { x: 16, y: after.viewport.h - 16 - 24 };
          const tip = after.pointer === null ? null : { x: after.pointer.box.left, y: after.pointer.box.top };
          const beforeTip = before.pointer === null ? null : { x: before.pointer.box.left, y: before.pointer.box.top };
          const answered = (result.json ?? {}) as { outcome?: string; reason?: string };
          const record: Record<string, unknown> = {
            id: row.id,
            tool: row.tool,
            args: redact(args),
            isError: result.isError,
            outcome: answered.outcome,
            reason: answered.reason,
            callMs: returnedAt - startedAt,
            expected,
            wordsSeen,
            captionAfter: after.caption?.words ?? null,
            captionRenderedAs: after.caption?.content ?? null,
            side: after.caption?.side ?? null,
            captionBox: after.caption?.box ?? null,
            faded: after.caption?.faded ?? null,
            pointerBefore: beforeTip,
            pointerAfter: tip,
            restSpot,
            mode: row.mode,
          };
          rowsOut.push(record);

          if (row.mode === "unchanged") {
            check.ok(wordsSeen.length === 0, `${row.id}: a call with no caption of its own changed the words: ${JSON.stringify(wordsSeen)}`);
            check.ok(
              (after.caption?.words ?? null) === (before.caption?.words ?? null),
              `${row.id}: the caption changed from ${JSON.stringify(before.caption?.words)} to ${JSON.stringify(after.caption?.words)}`,
            );
            check.ok(sameSpot(tip, beforeTip, 1.5), `${row.id}: the pointer moved from ${fmt(beforeTip)} to ${fmt(tip)}`);
          } else if (expected !== null) {
            check.ok(
              wordsSeen.includes(expected),
              `${row.id}: expected the caption ${JSON.stringify(expected)}, the page showed ${JSON.stringify(wordsSeen)} ` +
                `(page UI language must match HALLPASS_LOCALE=${locale})`,
            );
            if (row.replacesDocument !== true) {
              check.ok(after.caption?.words === expected, `${row.id}: after the call the caption reads ${JSON.stringify(after.caption?.words)}, not ${JSON.stringify(expected)}`);
              check.ok(
                (after.caption?.content ?? "").includes(expected),
                `${row.id}: the words are not drawn (::before content is ${JSON.stringify(after.caption?.content)})`,
              );
              check.ok(after.caption?.display !== "none", `${row.id}: the caption element is display:none`);
              // FR-503 in the ordinary case: wholly inside the viewport.
              const box = after.caption?.box;
              if (box && box.width > 0) {
                check.ok(
                  box.left >= -0.5 && box.top >= -0.5 && box.right <= after.viewport.w + 0.5 && box.bottom <= after.viewport.h + 0.5,
                  `${row.id}: the caption box ${JSON.stringify(box)} leaves the ${after.viewport.w}x${after.viewport.h} viewport`,
                );
              }
            }
            if (row.replacesDocument !== true) {
              if (row.mode === "rest") {
                check.ok(
                  sameSpot(tip, restSpot, 4),
                  `${row.id}: a rest step should leave the pointer at the rest spot ${fmt(restSpot)}, it is at ${fmt(tip)}`,
                );
              } else if (row.mode === "stay") {
                if (row.firstAppearance === true) {
                  check.ok(before.pointer === null, `${row.id}: the tab already had a pointer before its first captioned action`);
                  check.ok(sameSpot(tip, restSpot, 4), `${row.id}: FR-500 - a first stay step draws the pointer at the rest spot ${fmt(restSpot)}, it is at ${fmt(tip)}`);
                } else if (row.effectPointsAt !== undefined) {
                  // The caption step does not move the pointer; the effect's own focus step (pre-033) puts it on the target.
                  const box = await page.locator(row.effectPointsAt).boundingBox();
                  const inside = tip !== null && box !== null && tip.x >= box.x - 6 && tip.x <= box.x + box.width + 6 && tip.y >= box.y - 6 && tip.y <= box.y + box.height + 6;
                  check.ok(inside, `${row.id}: the tip ${fmt(tip)} is neither where it was nor over ${row.effectPointsAt} (${JSON.stringify(box)})`);
                } else {
                  check.ok(sameSpot(tip, beforeTip, 1.5), `${row.id}: a stay step moved the pointer from ${fmt(beforeTip)} to ${fmt(tip)}`);
                }
              } else if (row.mode === "travel") {
                check.ok(tip !== null, `${row.id}: a travel step left no pointer on the page`);
                if (row.lands !== undefined && tip !== null) {
                  const box = await page.locator(row.lands).boundingBox();
                  const inside = box !== null && tip.x >= box.x - 6 && tip.x <= box.x + box.width + 6 && tip.y >= box.y - 6 && tip.y <= box.y + box.height + 6;
                  check.ok(inside, `${row.id}: the tip ${fmt(tip)} is not over ${row.lands} (${JSON.stringify(box)})`);
                }
              }
            }
          }
          previousWords = expected ?? previousWords;

          // FR-501: a caption at a pointing position fades about a second after the pointer arrives;
          // one at the rest spot does not fade.
          if (row.id === "click") {
            const fade = await watchFade(page, returnedAt);
            record["fadedAfterMsFromReturn"] = fade;
            check.ok(fade !== null && fade >= 300 && fade <= 1800, `click: the pointing caption should fade about 1 s after arrival, it faded at ${String(fade)} ms after the call returned`);
          }
          if (row.id === "form_input") {
            await sleep(1600);
            const later = await page.evaluate(readPageState);
            record["fadedAfter1600ms"] = later.caption?.faded ?? null;
            check.ok(later.caption?.faded === false, "form_input: the caption at the rest spot faded (FR-501 says it stays)");
          }
          if (row.after) await row.after(ctx, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const elapsedMs = Date.now() - rowStartedAt;
          rowsOut.push({ id: row.id, tool: row.tool, args: redact(args), error: message, elapsedMs });
          check.ok(false, `${row.id}: the row threw after ${elapsedMs} ms (${row.tool} ${JSON.stringify(redact(args))}): ${message}`);
        }
      }
      void previousWords;

      // ---- US1 AS5: a browser_batch of three steps shows each step's caption as it starts ----
      {
        // The navigations replaced the document, so the refs read before them are gone: read them again.
        const reread = await live.callTool("read_page", { tabId, filter: "interactive" });
        const nodes = (reread.json as { nodes?: Array<{ ref?: string; name?: string }> } | undefined)?.nodes ?? [];
        const goRef = nodes.find((node) => node.name === "Go button")?.ref ?? "missing-ref:Go button";
        await sleep(300);
        const mark = await lastLogN(page);
        const result = await live.callTool("browser_batch", {
          tabId,
          steps: [
            { tool: "click", args: { target: { ref: goRef } } },
            { tool: "get_page_text", args: {} },
            { tool: "key", args: { key: "Tab" } },
          ],
        });
        await sleep(300);
        const seen = (await readLog(page))
          .filter((entry) => (entry["n"] as number) > mark && entry["k"] === "words")
          .map((entry) => String(entry["words"]));
        const wanted = [Words.click, Words.readPageText, Words.keyTab].map((w) => w[locale]);
        const inOrder = isSubsequence(wanted, seen);
        evidence["batch"] = { isError: result.isError, text: result.text.slice(0, 400), wordsSeen: seen, wanted, inOrder };
        check.ok(inOrder, `browser_batch: expected the captions ${JSON.stringify(wanted)} in order, the page showed ${JSON.stringify(seen)}`);
        await saveShot(page, testInfo, "live-1-batch.png");
      }

      note(
        testInfo,
        "not-reached",
        "scroll left / scroll right (the tools scroll up and down only; the computer tool's scroll has no horizontal form) " +
          "and drag via the computer tool (it has no drag action) have no call on fixtures; their words are pinned by the unit table.",
      );
      if (locale !== "zh-TW") {
        note(testInfo, "zh-TW", "not run: start the browser with --lang=zh-TW and HALLPASS_LOCALE=zh-TW for the zh-TW pass of this same table.");
      }
      await call(session, "tabs_close", { tabId });
      tab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-1-captions.json", evidence);
      if (tab && session) await call(session, "tabs_close", { tabId: tab.tabId }).catch(() => undefined);
      await session?.close();
      if (savedConfig === undefined) await writeFile(configPath, JSON.stringify({ uploadRoots: [] }), "utf8").catch(() => undefined);
      else await writeFile(configPath, savedConfig, "utf8").catch(() => undefined);
    }
    check.verify();
  });

  // ===========================================================================================
  // live-2 - the rest spot (US2)
  // ===========================================================================================
  test("live-2: after a tool that does not point the pointer rests bottom-left, and the next click leaves from there", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(240_000);
    const check = checker();
    const evidence: Record<string, unknown> = { locale };
    const opening = Words.navigate(HOST)[locale];

    let session: Session | undefined;
    let tab: Tab | undefined;
    try {
      session = await openSession({ extensionContext, extensionId, extensionWorker });
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;
      const first = await page.evaluate(readPageState);
      const mid = { x: Math.round(first.viewport.w / 2), y: Math.round(first.viewport.h / 2) };
      evidence["viewport"] = first.viewport;
      const rest = { x: 16, y: first.viewport.h - 16 - 24 };
      evidence["restSpot"] = rest;

      // ---- 1. click mid-page: the pointer is there ----
      await live.callTool("computer", { tabId, action: "left_click", x: mid.x, y: mid.y });
      const clicked = await stillPointer(page, 450);
      evidence["afterClick"] = summarise(clicked);
      check.ok(sameSpot(tipOf(clicked), mid, 4), `after the click the pointer should be at ${fmt(mid)}, it is at ${fmt(tipOf(clicked))}`);
      await saveShot(page, testInfo, "live-2-1-after-click.png");

      // ---- 2. a same-document navigate (hash only): the document survives, so the whole claim is visible ----
      const hashUrl = `${SITE}${MAIN_PATH}#rest`;
      const hashNav = await live.callTool("navigate", { tabId, url: hashUrl });
      const hashReturned = Date.now();
      evidence["sameDocumentNavigate"] = { isError: hashNav.isError, text: hashNav.text.slice(0, 300) };
      const atRest = await stillPointer(page, 600);
      const early = await page.evaluate(readPageState);
      await sleep(Math.max(0, 1700 - (Date.now() - hashReturned)));
      const late = await page.evaluate(readPageState);
      evidence["sameDocumentRest"] = { early: summarise(early), late: summarise(late) };
      check.ok(!hashNav.isError, `navigate to ${hashUrl} failed: ${hashNav.text.slice(0, 200)}`);
      check.ok(sameSpot(tipOf(atRest), rest, 4), `US2 AS1: after navigate the pointer should be at the rest spot ${fmt(rest)}, it is at ${fmt(tipOf(atRest))}`);
      check.ok(early.caption?.words === opening, `US2 AS1: the caption should read ${JSON.stringify(opening)}, it reads ${JSON.stringify(early.caption?.words)}`);
      check.ok(
        late.caption?.words === opening && late.caption.faded === false && late.caption.opacity > 0.9,
        `US2 AS1: the rest caption must still be there 1.5 s later (faded=${String(late.caption?.faded)}, opacity=${String(late.caption?.opacity)})`,
      );
      check.ok(sameSpot(tipOf(late), rest, 4), `the pointer left the rest spot while the caption stayed: ${fmt(tipOf(late))}`);
      await saveShot(page, testInfo, "live-2-2-rest-after-navigate.png");

      // ---- 3. the next click travels FROM the rest spot ----
      const target = { x: mid.x + 120, y: mid.y - 80 };
      const sinceT = Date.now() - 30;
      await live.callTool("computer", { tabId, action: "left_click", x: target.x, y: target.y });
      await sleep(150);
      const samples = await settle(() => page.evaluate(readSamples, sinceT));
      const travel = analyseTravel(samples, target);
      evidence["clickFromRest"] = { target, firstSample: samples[0] ?? null, lastSample: samples[samples.length - 1] ?? null, travel };
      check.ok(samples.length > 0, "no pointer samples were taken during the click (is the tab visible?)");
      check.ok(
        samples.length > 0 && sameSpot(samples[0] ?? null, rest, 6),
        `US2 AS2: the click should start from the rest spot ${fmt(rest)}, the first sample is ${fmt(samples[0] ?? null)}`,
      );
      check.ok(sameSpot(travel.end, target, 3), `the click should end at ${fmt(target)}, it ends at ${fmt(travel.end)}`);

      // ---- 4. the quickstart's own step: a navigate to another document ----
      await live.callTool("computer", { tabId, action: "left_click", x: mid.x, y: mid.y });
      await stillPointer(page, 450);
      const mark = await lastLogN(page);
      const nextUrl = `${SITE}${MAIN_PATH}?rest=2`;
      const crossNav = await live.callTool("navigate", { tabId, url: nextUrl });
      const crossReturned = Date.now();
      await settle(() => page.waitForLoadState("load"));
      // Give the new document a moment to draw whatever it is going to draw.
      let fresh: PageState | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        fresh = await settle(() => page.evaluate(readPageState));
        if (fresh.pointer !== null && fresh.caption?.words === opening) break;
        await sleep(100);
      }
      const events = (await readLog(page)).filter((entry) => (entry["n"] as number) > mark);
      const freshSettled = await stillPointer(page, 450);
      await sleep(Math.max(0, 1700 - (Date.now() - crossReturned)));
      const freshLate = await page.evaluate(readPageState);
      evidence["crossDocumentNavigate"] = {
        isError: crossNav.isError,
        text: crossNav.text.slice(0, 300),
        newDocumentPointer: summarise(freshSettled),
        newDocumentAfter1500ms: summarise(freshLate),
        events,
      };
      await saveShot(page, testInfo, "live-2-4-after-cross-document-navigate.png");
      check.ok(!crossNav.isError, `navigate to ${nextUrl} failed: ${crossNav.text.slice(0, 200)}`);
      check.ok(
        freshSettled.pointer !== null && sameSpot(tipOf(freshSettled), rest, 4) && freshSettled.caption?.words === opening,
        `quickstart 2: after a navigate to another document the pointer should be at the rest spot with ${JSON.stringify(opening)}; ` +
          `the new document shows pointer=${fmt(tipOf(freshSettled))} caption=${JSON.stringify(freshSettled.caption?.words ?? null)} ` +
          "(the rest step is sent to the document that is being left - see the events in the evidence)",
      );
      check.ok(freshLate.caption?.words === opening && freshLate.caption.faded === false, "quickstart 2: the rest caption is gone or faded 1.5 s after the navigate");

      // ---- 5. and a click after that, from wherever the pointer is ----
      if (freshLate.pointer !== null) {
        const sinceNext = Date.now() - 30;
        await live.callTool("computer", { tabId, action: "left_click", x: target.x, y: target.y });
        await sleep(150);
        const nextSamples = await settle(() => page.evaluate(readSamples, sinceNext));
        evidence["clickAfterCrossDocument"] = { firstSample: nextSamples[0] ?? null };
        check.ok(sameSpot(nextSamples[0] ?? null, rest, 6), `the click after the navigate should leave the rest spot ${fmt(rest)}, the first sample is ${fmt(nextSamples[0] ?? null)}`);
      } else {
        evidence["clickAfterCrossDocument"] = "skipped: the new document had no pointer";
      }
      await call(session, "tabs_close", { tabId });
      tab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-2-rest.json", evidence);
      if (tab && session) await call(session, "tabs_close", { tabId: tab.tabId }).catch(() => undefined);
      await session?.close();
    }
    check.verify();
  });

  // ===========================================================================================
  // live-3 - distance-aware curved motion, one ring per press, the page reacts after arrival (SC-221)
  // ===========================================================================================
  test("live-3: near and far clicks, curved path, one ring after arrival, the page reacts after the pointer stops", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const check = checker();
    const evidence: Record<string, unknown> = { locale, slackMs: SLACK_MS, frameMs: FRAME_MS };

    let session: Session | undefined;
    let tab: Tab | undefined;
    try {
      session = await openSession({ extensionContext, extensionId, extensionWorker });
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;
      evidence["viewportMethod"] = "the viewport tool (emulated 1280x800), so the far move is a real 800 px";
      await call(session, "viewport", { tabId, action: "set", width: 1280, height: 800 });
      await waitForViewport(page, 1280, 800);
      await showTab(page);

      const clickAt = async (point: Point): Promise<ClickMeasure> => {
        const mark = await lastLogN(page);
        const sinceT = Date.now() - 20;
        const startedAt = Date.now();
        const result = await live.callTool("computer", { tabId, action: "left_click", x: point.x, y: point.y });
        const returnedAt = Date.now();
        await sleep(150);
        const samples = await settle(() => page.evaluate(readSamples, sinceT));
        const events = (await readLog(page)).filter((entry) => (entry["n"] as number) > mark);
        return measureClick({ point, startedAt, returnedAt, samples, events, isError: result.isError });
      };

      // Settle the pointer at the rest spot, then one click to take it off the corner.
      const warm = await clickAt({ x: 200, y: 200 });
      const sequence: Array<{ label: string; point: Point }> = [
        { label: "near-1", point: { x: 240, y: 200 } }, // 40 px
        { label: "far-1", point: { x: 1040, y: 200 } }, // 800 px
        { label: "near-2", point: { x: 1000, y: 200 } }, // 40 px
        { label: "far-2", point: { x: 200, y: 200 } }, // 800 px
      ];
      const measures: Record<string, ClickMeasure> = {};
      for (const step of sequence) {
        const measure = await clickAt(step.point);
        measures[step.label] = measure;
        if (step.label === "far-1") await saveShot(page, testInfo, "live-3-after-far-1.png");
      }
      evidence["warmUp"] = warm;
      evidence["clicks"] = measures;
      await sleep(900);
      evidence["ringsLeftAfter900ms"] = (await page.evaluate(readPageState)).rings;

      for (const [label, m] of Object.entries(measures)) {
        check.ok(m.samples > 3, `${label}: only ${m.samples} pointer samples - the tab is not producing frames`);
        check.ok(
          m.durationMs !== null && m.durationMs >= 140 - SLACK_MS && m.durationMs <= 380 + SLACK_MS,
          `${label}: travel took ${String(m.durationMs)} ms, expected 140-380 (+${SLACK_MS} ms sampling slack)`,
        );
        check.ok(m.endError !== null && m.endError <= 3, `${label}: the pointer ended ${String(m.endError)} px from the target`);
        check.ok(m.rings === 1, `${label}: ${m.rings} rings appeared, expected exactly one`);
        check.ok(
          m.ringAfterArrivalMs !== null && m.ringAfterArrivalMs >= -SLACK_MS,
          `${label}: the ring appeared ${String(m.ringAfterArrivalMs)} ms after the pointer stopped (before it)`,
        );
        check.ok(m.ringLifetimeMs !== null && m.ringLifetimeMs <= 1000, `${label}: the ring lived ${String(m.ringLifetimeMs)} ms (limit 1000)`);
        check.ok(
          m.firstEventAfterArrivalMs !== null && m.firstEventAfterArrivalMs >= -FRAME_MS,
          `${label}: the page saw its first input ${String(m.firstEventAfterArrivalMs)} ms after the pointer stopped (FR-508: after)`,
        );
        check.ok(
          m.clickAfterArrivalMs !== null && m.clickAfterArrivalMs >= -FRAME_MS,
          `${label}: the page's click listener ran ${String(m.clickAfterArrivalMs)} ms after the pointer stopped (US3 AS2: after)`,
        );
      }
      const dur = (label: string): number => measures[label]?.durationMs ?? Number.NaN;
      check.ok(dur("far-1") > dur("near-1"), `far-1 (${dur("far-1")} ms) should take longer than near-1 (${dur("near-1")} ms)`);
      check.ok(dur("far-2") > dur("near-2"), `far-2 (${dur("far-2")} ms) should take longer than near-2 (${dur("near-2")} ms)`);
      // The path bends: the planner's sideways bend is 10 % of the distance up to 24 px, so the long
      // moves bow by tens of pixels and the 40 px ones by a few.
      for (const label of ["far-1", "far-2"]) {
        const bow = measures[label]?.maxBowPx ?? 0;
        check.ok(bow >= 8, `${label}: the path bows only ${bow.toFixed(1)} px from the straight line (expected ~24)`);
      }
      for (const label of ["near-1", "near-2"]) {
        const bow = measures[label]?.maxBowPx ?? 0;
        check.ok(bow >= 1, `${label}: the path bows only ${bow.toFixed(1)} px from the straight line (expected ~4)`);
      }

      // ---- SC-221: 20 clicks at mixed distances, every reaction after the pointer stopped ----
      const series: ClickMeasure[] = [];
      let seed = 33;
      const next = (): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let index = 0; index < 20; index += 1) {
        series.push(await clickAt({ x: Math.round(60 + next() * 1160), y: Math.round(100 + next() * 600) }));
      }
      evidence["series20"] = series;
      const reacted = series.filter((m) => m.clickAfterArrivalMs !== null && m.clickAfterArrivalMs >= -FRAME_MS).length;
      check.ok(reacted === series.length, `SC-221: ${reacted}/20 clicks reached the page after the pointer had stopped`);
      const worstWait = Math.max(...series.map((m) => m.pressAfterTravelStartMs ?? 0));
      evidence["series20WorstPressAfterTravelStartMs"] = worstWait;
      check.ok(worstWait <= 450 + 100, `SC-221: a press came ${worstWait} ms after its travel began (cap 450 ms + 100 ms dispatch slack)`);
      check.ok(series.every((m) => m.rings === 1), `SC-221: some of the 20 clicks showed ${series.map((m) => m.rings).join(",")} rings, expected one each`);

      note(testInfo, "out-of-scope", "reduced motion (OS 'Animation effects' off) is not exercised here, as agreed.");
      await call(session, "viewport", { tabId, action: "reset" }).catch(() => undefined);
      await call(session, "tabs_close", { tabId });
      tab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-3-motion-ripple.json", evidence);
      if (tab && session) {
        await call(session, "viewport", { tabId: tab.tabId, action: "reset" }).catch(() => undefined);
        await call(session, "tabs_close", { tabId: tab.tabId }).catch(() => undefined);
      }
      await session?.close();
    }
    check.verify();
  });

  // ===========================================================================================
  // live-4 - the caption stays inside the viewport at corners and edge midpoints (SC-220)
  // ===========================================================================================
  test("live-4: the caption is fully visible at the four corners and four edge midpoints of 1280x800 and 400x700", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const check = checker();
    const evidence: Record<string, unknown> = {
      locale,
      viewportMethod: "the viewport tool (emulated viewport via the debugger), then a computer left_click at each point",
      placements: [] as unknown[],
    };
    const out = evidence["placements"] as unknown[];

    let session: Session | undefined;
    let tab: Tab | undefined;
    try {
      session = await openSession({ extensionContext, extensionId, extensionWorker });
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;

      for (const size of [
        { w: 1280, h: 800 },
        { w: 400, h: 700 },
      ]) {
        await call(session, "viewport", { tabId, action: "set", width: size.w, height: size.h });
        await waitForViewport(page, size.w, size.h);
        await showTab(page);
        const inset = 4;
        const points: Array<{ name: string; x: number; y: number }> = [
          { name: "top-left", x: inset, y: inset },
          { name: "top-middle", x: size.w / 2, y: inset },
          { name: "top-right", x: size.w - inset, y: inset },
          { name: "left-middle", x: inset, y: size.h / 2 },
          { name: "right-middle", x: size.w - inset, y: size.h / 2 },
          { name: "bottom-left", x: inset, y: size.h - inset },
          { name: "bottom-middle", x: size.w / 2, y: size.h - inset },
          { name: "bottom-right", x: size.w - inset, y: size.h - inset },
        ];
        for (const point of points) {
          const label = `${size.w}x${size.h}-${point.name}`;
          const result = await live.callTool("computer", { tabId, action: "left_click", x: point.x, y: point.y });
          const state = await settle(() => page.evaluate(readPageState));
          const box = state.caption?.box ?? null;
          const spare =
            box === null ? null : { left: box.left, top: box.top, right: state.viewport.w - box.right, bottom: state.viewport.h - box.bottom };
          const minSpare = spare === null ? null : Math.min(spare.left, spare.top, spare.right, spare.bottom);
          out.push({
            label,
            isError: result.isError,
            words: state.caption?.words ?? null,
            side: state.caption?.side ?? null,
            viewport: state.viewport,
            pointer: tipOf(state),
            captionBox: box,
            spare,
            minSpare,
          });
          await saveShot(page, testInfo, `live-4-${label}.png`);
          check.ok(!result.isError, `${label}: the click failed: ${result.text.slice(0, 200)}`);
          check.ok(box !== null && box.width > 0, `${label}: no caption box on the page`);
          if (box !== null && box.width > 0) {
            check.ok(
              box.left >= -0.5 && box.top >= -0.5 && box.right <= state.viewport.w + 0.5 && box.bottom <= state.viewport.h + 0.5,
              `SC-220 ${label}: the caption ${JSON.stringify(box)} is not inside ${state.viewport.w}x${state.viewport.h}`,
            );
            check.ok(minSpare !== null && minSpare >= 8 - 0.5, `FR-503 ${label}: only ${String(minSpare)} px of room to the viewport edge (expected 8)`);
          }
          check.ok(sameSpot(tipOf(state), point, 3), `${label}: the pointer tip is at ${fmt(tipOf(state))}, expected ${fmt(point)}`);
        }
      }
      await call(session, "viewport", { tabId, action: "reset" }).catch(() => undefined);
      await call(session, "tabs_close", { tabId });
      tab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-4-edges.json", evidence);
      if (tab && session) {
        await call(session, "viewport", { tabId: tab.tabId, action: "reset" }).catch(() => undefined);
        await call(session, "tabs_close", { tabId: tab.tabId }).catch(() => undefined);
      }
      await session?.close();
    }
    check.verify();
  });

  // ===========================================================================================
  // live-5 - the caption is a mark, not page text (FR-504, SC-222)
  // ===========================================================================================
  test("live-5: the caption's words are not found by the page's own search, its text, the selection, find or get_page_text", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(240_000);
    const check = checker();
    const evidence: Record<string, unknown> = {
      locale,
      stand_in: "window.find() stands in for Ctrl+F (the browser's find bar cannot be driven from the runner)",
      rounds: [] as unknown[],
    };
    const rounds = evidence["rounds"] as unknown[];

    let session: Session | undefined;
    let tab: Tab | undefined;
    try {
      session = await openSession({ extensionContext, extensionId, extensionWorker });
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;

      // Rest first, so the caption is at the rest spot and does not fade while it is being searched.
      await call(session, "viewport", { tabId, action: "set", width: 1000, height: 700 });
      await waitForViewport(page, 1000, 700);
      await showTab(page);

      const calls: Array<{ id: string; tool: string; args: Record<string, unknown>; words: string }> = [
        { id: "get_page_text", tool: "get_page_text", args: {}, words: Words.readPageText[locale] },
        { id: "read_page", tool: "read_page", args: { filter: "all" }, words: Words.readPage[locale] },
        { id: "find", tool: "find", args: { query: "Go button" }, words: Words.find("Go button")[locale] },
        { id: "key", tool: "key", args: { key: "End" }, words: Words.keyEnd[locale] },
        { id: "wait", tool: "wait", args: { forMs: 1200 }, words: Words.wait("1.2")[locale] },
      ];
      for (const entry of calls) {
        const started = live.callTool(entry.tool, { tabId, ...entry.args });
        // The wait lasts long enough to read the caption while it is the live call.
        if (entry.id === "wait") await sleep(300);
        const result = await started;
        const state = await settle(() => page.evaluate(readPageState));
        // The criterion is the caption as shown (FR-504, SC-222), so the whole string is what is
        // searched for; its single words are ordinary page vocabulary and are only recorded.
        const words = entry.words.split(/\s+/u).filter((word) => word.length >= 4);
        const probe = await page.evaluate(searchForWords, [entry.words, words] as const);
        const toolText = result.text;
        const row = {
          id: entry.id,
          isError: result.isError,
          captionShown: state.caption?.words ?? null,
          captionFaded: state.caption?.faded ?? null,
          caption: entry.words,
          pageSearch: probe,
          toolAnswerHasCaption: toolText.includes(entry.words),
          recordedOnly: { toolAnswerWords: words.filter((word) => toolText.includes(word)) },
        };
        rounds.push(row);
        await saveShot(page, testInfo, `live-5-${entry.id}.png`);
        check.ok(state.caption?.words === entry.words, `${entry.id}: expected the caption ${JSON.stringify(entry.words)} to be up while searching, the page shows ${JSON.stringify(state.caption?.words)}`);
        check.ok(!probe.windowFindCaption, `${entry.id}: window.find located the caption ${JSON.stringify(entry.words)}`);
        check.ok(!probe.innerTextHasCaption, `${entry.id}: document.body.innerText contains the caption ${JSON.stringify(entry.words)}`);
        check.ok(!probe.textContentHasCaption, `${entry.id}: the page's textContent (without <style> and <script>) contains the caption ${JSON.stringify(entry.words)}`);
        check.ok(!probe.selectionHasCaption, `${entry.id}: the select-all selection text contains the caption ${JSON.stringify(entry.words)}`);
        check.ok(!row.toolAnswerHasCaption, `${entry.id}: the ${entry.tool} answer contains the caption ${JSON.stringify(entry.words)}`);
      }

      // Now the two readers the agent has, asked for the caption's own words while it is up.
      const words = Words.readPageText[locale];
      const reading = await live.callTool("get_page_text", { tabId });
      const found = await live.callTool("find", { tabId, query: words });
      const readAll = await live.callTool("read_page", { tabId, filter: "all" });
      evidence["agentReaders"] = {
        caption: (await page.evaluate(readPageState)).caption?.words ?? null,
        getPageTextContainsWords: reading.text.includes(words),
        findAnswer: found.text.slice(0, 600),
        findReturnedNothing: ((found.json as { matches?: unknown[] } | undefined)?.matches ?? []).length === 0,
        readPageContainsWords: readAll.text.includes(words),
      };
      check.ok(!reading.text.includes(words), `get_page_text returned the caption words ${JSON.stringify(words)}`);
      check.ok(!readAll.text.includes(words), `read_page returned the caption words ${JSON.stringify(words)}`);
      check.ok(
        ((found.json as { matches?: unknown[] } | undefined)?.matches ?? []).length === 0 &&
          !JSON.stringify((found.json as { matches?: unknown } | undefined)?.matches ?? []).includes(words),
        `find for the caption's own words returned matches: ${found.text.slice(0, 300)}`,
      );

      await call(session, "viewport", { tabId, action: "reset" }).catch(() => undefined);
      await call(session, "tabs_close", { tabId });
      tab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-5-not-text.json", evidence);
      if (tab && session) {
        await call(session, "viewport", { tabId: tab.tabId, action: "reset" }).catch(() => undefined);
        await call(session, "tabs_close", { tabId: tab.tabId }).catch(() => undefined);
      }
      await session?.close();
    }
    check.verify();
  });

  // ===========================================================================================
  // live-6 - captures returned to the agent carry no marks; GIF frames keep them (FR-509, SC-223)
  // ===========================================================================================
  test("live-6: screenshots (whole, region, computer) hide the pointer, caption, pill and glow and bring them back", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(420_000);
    const check = checker();
    const evidence: Record<string, unknown> = {
      locale,
      method:
        "pixels of the returned image at the places the marks are drawn are compared with the page background (white, tolerance 16); " +
        "a Playwright screenshot of the same page, taken with the marks up, is the control that proves each place CAN show a mark",
      captures: [] as unknown[],
    };
    const captures = evidence["captures"] as unknown[];

    let session: Session | undefined;
    let tab: Tab | undefined;
    let cspTab: Tab | undefined;
    try {
      session = await openSession({ extensionContext, extensionId, extensionWorker });
      const helper = session.settings.page; // decodes the images (an extension page, never the agent's)
      tab = await useTab(session, MAIN_PATH);
      const { page, tabId } = tab;
      const live = session.client;
      await call(session, "viewport", { tabId, action: "set", width: 1280, height: 800 });
      await waitForViewport(page, 1280, 800);
      await showTab(page);

      const run = (tabNow: Tab, label: string, scenario: "rest" | "pointing"): Promise<void> =>
        captureScenario({ tab: tabNow, label, scenario, live, helper, testInfo, check, captures });

      // ---- the page the marks were measured on: rest caption, then a click's pointing caption ----
      await run(tab, "main", "rest");
      await run(tab, "main", "pointing");

      // ---- the GIF: marks stay in the frames (D-033-5); nothing is hidden outside the screenshot call ----
      {
        const gifMark = await lastLogN(page);
        const started = Date.now();
        const startedGif = await live.callTool("gif_recorder", { action: "start" });
        await live.callTool("computer", { tabId, action: "left_click", x: 900, y: 560 });
        const shotStart = Date.now();
        const shot = await live.callTool("screenshot", { tabId });
        const shotEnd = Date.now();
        const stopped = await live.callTool("gif_recorder", { action: "stop" });
        const exported = await live.callTool("gif_recorder", { action: "export", filename: "hallpass-033-live-6" });
        const ended = Date.now();
        const hides = (await readLog(page)).filter((entry) => (entry["n"] as number) > gifMark && entry["k"] === "hidden" && entry["on"] === true);
        const outside = hides.filter((entry) => (entry["t"] as number) < shotStart - 50 || (entry["t"] as number) > shotEnd + 100);
        const exportedAnswer = (exported.json ?? {}) as { filename?: string; frames?: number; bytes?: number; width?: number; height?: number };
        let copiedTo: string | null = null;
        if (typeof exportedAnswer.filename === "string") {
          for (const candidate of [exportedAnswer.filename, join(homedir(), "Downloads", exportedAnswer.filename)]) {
            if (existsSync(candidate)) {
              copiedTo = testInfo.outputPath("live-6-recording.gif");
              await copyFile(candidate, copiedTo);
              break;
            }
          }
        }
        evidence["gif"] = {
          start: startedGif.json,
          stopped: stopped.json,
          exported: exportedAnswer,
          screenshotIsError: shot.isError,
          hidesInWholeRun: hides.length,
          hidesOutsideTheScreenshotCall: outside,
          exportFileCopied: copiedTo,
          totalMs: ended - started,
          frameContents:
            "NOT decoded here (no GIF decoder in the repository): open live-6-recording.gif, or the file named in 'exported.filename', and look at the click frame - the pointer and caption should be drawn in it, and the frame after the screenshot should have them back",
        };
        check.ok(!startedGif.isError && !exported.isError, `gif_recorder failed: start=${startedGif.text.slice(0, 120)} export=${exported.text.slice(0, 160)}`);
        check.ok(outside.length === 0, `D-033-5: marks were hidden outside the screenshot call while recording: ${JSON.stringify(outside)}`);
        check.ok(hides.length > 0, "the screenshot taken during the recording did not hide any mark (FR-509)");
        check.ok((exportedAnswer.frames ?? 0) >= 2, `the recording holds ${String(exportedAnswer.frames)} frames, expected the initial one and at least one after the click`);
        const state = await settle(() => page.evaluate(readPageState));
        check.ok(state.pointer !== null && !state.pointer.hidden, "after the recorded screenshot the pointer is not back on the page");
        note(testInfo, "gif-frames", "GIF frame contents are not decoded by this spec; the file is copied to the evidence directory when it can be found (see live-6-capture JSON, gif.exportFileCopied).");
      }

      // ---- the strict-CSP page: hiding must still work; what the stylesheet-less marks look like is only recorded ----
      await call(session, "tabs_close", { tabId });
      tab = undefined;
      cspTab = await useTab(session, CSP_PATH);
      const cspPage = cspTab.page;
      await call(session, "viewport", { tabId: cspTab.tabId, action: "set", width: 1280, height: 800 });
      await waitForViewport(cspPage, 1280, 800);
      await showTab(cspPage);
      await run(cspTab, "csp", "rest");
      await run(cspTab, "csp", "pointing");
      // Recorded, not asserted: does the stylesheet apply under the policy?
      await live.callTool("computer", { tabId: cspTab.tabId, action: "left_click", x: 900, y: 560 });
      await sleep(150);
      const cspState = await settle(() => cspPage.evaluate(readPageState));
      const cspLog = (await readLog(cspPage)).filter((entry) => entry["k"] === "ring+");
      const cspPolicy = await cspPage.evaluate(() => ({
        styleElementPresent: document.querySelector("style[data-hallpass-cursor-style]") !== null,
        styleSheetsApplied: [...document.styleSheets].length,
      }));
      evidence["cspRecorded"] = {
        note: "RECORDED, not asserted (main needs the fact)",
        captionRendersItsWords: cspState.caption !== null && cspState.caption.content !== "none" && cspState.caption.content.includes(cspState.caption.words),
        captionPseudoContent: cspState.caption?.content ?? null,
        captionComputedPosition: cspState.caption?.position ?? null,
        captionBox: cspState.caption?.box ?? null,
        captionWords: cspState.caption?.words ?? null,
        injectedStyleElement: cspPolicy,
        ringAppeared: cspLog.length > 0,
        ringBoxAtInsertion: cspLog.map((entry) => ({ w: entry["w"], h: entry["h"] })),
        ringIsVisibleSized: cspLog.some((entry) => Number(entry["w"]) > 0 && Number(entry["h"]) > 0),
      };
      await saveShot(cspPage, testInfo, "live-6-csp-click.png");
      await call(session, "viewport", { tabId: cspTab.tabId, action: "reset" }).catch(() => undefined);
      await call(session, "tabs_close", { tabId: cspTab.tabId });
      cspTab = undefined;
    } finally {
      await writeEvidence(testInfo, "live-6-captures.json", evidence);
      for (const left of [tab, cspTab]) {
        if (left && session) {
          await call(session, "viewport", { tabId: left.tabId, action: "reset" }).catch(() => undefined);
          await call(session, "tabs_close", { tabId: left.tabId }).catch(() => undefined);
        }
      }
      await session?.close();
    }
    check.verify();
  });
});

// =============================================================================================
// Expected words (FR-499), written out here independently of the catalog and of pointer-captions.ts
// =============================================================================================

const HOST = "127.0.0.1";
type Locales = { "en-US": string; "zh-TW": string };
const w = (en: string, zh: string): Locales => ({ "en-US": en, "zh-TW": zh });

const Words = {
  click: w("Clicking", "點擊"),
  doubleClick: w("Double-clicking", "雙擊"),
  tripleClick: w("Triple-clicking", "三連擊"),
  rightClick: w("Right-clicking", "按右鍵"),
  hover: w("Pointing", "移動游標"),
  drag: w("Dragging", "拖曳"),
  scrollDown: w("Scrolling down", "向下捲動"),
  scrollUp: w("Scrolling up", "向上捲動"),
  scrollToElement: w("Scrolling to element", "捲動到元素"),
  type: w("Typing", "輸入文字"),
  keyTab: w("Pressing Tab", "按下 Tab"),
  keyEnd: w("Pressing End", "按下 End"),
  back: w("Going back", "上一頁"),
  forward: w("Going forward", "下一頁"),
  formInput: w("Filling in a field", "填寫欄位"),
  evaluate: w("Running page script", "執行頁面腳本"),
  fileUpload: w("Uploading file", "上傳檔案"),
  uploadImage: w("Uploading image", "上傳圖片"),
  resize: w("Resizing window", "調整視窗大小"),
  readPage: w("Reading page", "讀取頁面"),
  readPageText: w("Reading page text", "讀取頁面文字"),
  readConsole: w("Reading console", "讀取主控台"),
  readNetwork: w("Reading network activity", "讀取網路活動"),
  navigate: (host: string): Locales => w(`Opening ${host}`, `開啟 ${host}`),
  find: (query: string): Locales => w(`Finding “${query}”`, `尋找「${query}」`),
  wait: (seconds: string): Locales => w(`Waiting ${seconds} seconds`, `等待 ${seconds} 秒`),
} as const;

type RowContext = {
  tabId: number;
  refs: Record<string, string>;
  uploadFile: string;
  outer: { w: number; h: number };
  imageId?: string;
};

type RowSpec = {
  id: string;
  tool: string;
  args: (ctx: RowContext) => Record<string, unknown>;
  /** `null`: the call has no caption of its own and must leave the words and the pointer alone. */
  words: Locales | null;
  mode: "travel" | "stay" | "rest" | "unchanged";
  /** For a travel row: the element the tip must end over. */
  lands?: string;
  /** A stay row whose effect itself puts the pointer on this element (type with a target focuses it first). */
  effectPointsAt?: string;
  firstAppearance?: true;
  /** The navigation replaces the document, so only the words seen while it was the old one count. */
  replacesDocument?: true;
  needsDiagnostics?: true;
  /** A pre-existing defect that leaves the call unsettled; the row is skipped with this reason. */
  knownHang?: string;
  after?: (ctx: RowContext, result: ToolCallResult) => void | Promise<void>;
};

const ref = (ctx: RowContext, name: string): { ref: string } => ({ ref: ctx.refs[name] ?? `missing-ref:${name}` });

/** One row per FR-499 line reachable on the fixture, in an order that never repeats a caption back to back. */
function captionRows(): RowSpec[] {
  const GO = { x: 370, y: 220 };
  return [
    {
      id: "read_page",
      tool: "read_page",
      args: () => ({ filter: "all" }),
      words: Words.readPage,
      mode: "stay",
      firstAppearance: true,
      after: (ctx, result) => {
        const nodes = (result.json as { nodes?: Array<{ ref?: string; role?: string; name?: string }> } | undefined)?.nodes ?? [];
        for (const node of nodes) if (node.ref !== undefined && node.name !== undefined) ctx.refs[node.name] = node.ref;
        const file = nodes.find((node) => node.role === "file" && node.ref !== undefined);
        if (file?.ref !== undefined) ctx.refs["Attachment"] = file.ref;
      },
    },
    { id: "click", tool: "click", args: (c) => ({ target: ref(c, "Go button") }), words: Words.click, mode: "travel", lands: "#go" },
    { id: "get_page_text", tool: "get_page_text", args: () => ({}), words: Words.readPageText, mode: "stay" },
    { id: "double_click", tool: "double_click", args: (c) => ({ target: ref(c, "Go button") }), words: Words.doubleClick, mode: "travel", lands: "#go" },
    {
      id: "find",
      tool: "find",
      args: () => ({ query: "Name field" }),
      words: Words.find("Name field"),
      mode: "stay",
    },
    { id: "triple_click", tool: "triple_click", args: (c) => ({ target: ref(c, "Go button") }), words: Words.tripleClick, mode: "travel", lands: "#go" },
    { id: "type", tool: "type", args: (c) => ({ target: ref(c, "Name field"), text: "abc" }), words: Words.type, mode: "stay", effectPointsAt: "#name" },
    { id: "right_click", tool: "right_click", args: (c) => ({ target: ref(c, "Go button") }), words: Words.rightClick, mode: "travel", lands: "#go" },
    { id: "key", tool: "key", args: () => ({ key: "Tab" }), words: Words.keyTab, mode: "stay" },
    { id: "hover", tool: "hover", args: (c) => ({ target: ref(c, "Hover target") }), words: Words.hover, mode: "travel", lands: "#hover" },
    { id: "read_console", tool: "read_console", args: () => ({}), words: Words.readConsole, mode: "stay", needsDiagnostics: true },
    { id: "drag", tool: "drag", args: (c) => ({ from: ref(c, "Alpha"), to: ref(c, "Beta") }), words: Words.drag, mode: "travel" },
    { id: "read_network", tool: "read_network", args: () => ({}), words: Words.readNetwork, mode: "stay", needsDiagnostics: true },
    { id: "form_input", tool: "form_input", args: (c) => ({ ref: ctxRef(c, "Plan"), value: "pro" }), words: Words.formInput, mode: "rest" },
    {
      id: "find-far",
      tool: "find",
      args: () => ({ query: "Far button" }),
      words: Words.find("Far button"),
      mode: "stay",
      after: (ctx, result) => {
        const first = (result.json as { matches?: Array<{ ref?: string }> } | undefined)?.matches?.[0];
        if (first?.ref !== undefined) ctx.refs["Far button"] = first.ref;
      },
    },
    // The scroll tool scrolls through the content runtime and never moves the pointer: its rows `stay`
    // (live run 2026-11-13). The computer tool's scroll goes through the pointer and travels.
    { id: "scroll-down", tool: "scroll", args: () => ({ direction: "down", amount: "small" }), words: Words.scrollDown, mode: "stay" },
    { id: "wait", tool: "wait", args: () => ({ forMs: 1500 }), words: Words.wait("1.5"), mode: "stay" },
    { id: "scroll-up", tool: "scroll", args: () => ({ direction: "up", amount: "small" }), words: Words.scrollUp, mode: "stay" },
    { id: "scroll-to-element", tool: "scroll", args: (c) => ({ target: ref(c, "Far button") }), words: Words.scrollToElement, mode: "stay" },
    { id: "evaluate", tool: "evaluate", args: () => ({ expression: "1 + 1" }), words: Words.evaluate, mode: "rest", needsDiagnostics: true },
    // Back to the top before the computer rows, whose coordinates are the fixture's fixed ones: the row
    // above scrolled the page down to the Far button, so the Go button is no longer at (370, 220).
    // `key` Home is not used: it would put the "Pressing Home" caption between two rows of its own.
    { id: "scroll-back-to-go", tool: "scroll", args: (c) => ({ target: ref(c, "Go button") }), words: Words.scrollToElement, mode: "stay" },
    // #67's order: End scrolls the page to the bottom, then the computer clicks land on a scrolled
    // page (none of them checks what it lands on). It hung while the frame-site walk hit-tested the
    // viewport point as a document point.
    { id: "computer-key", tool: "computer", args: () => ({ action: "key", key: "End" }), words: Words.keyEnd, mode: "stay" },
    { id: "computer-left_click", tool: "computer", args: () => ({ action: "left_click", x: GO.x, y: GO.y }), words: Words.click, mode: "travel" },
    { id: "computer-double_click", tool: "computer", args: () => ({ action: "double_click", x: 500, y: 300 }), words: Words.doubleClick, mode: "travel" },
    { id: "computer-type", tool: "computer", args: () => ({ action: "type", text: "x" }), words: Words.type, mode: "stay" },
    { id: "computer-triple_click", tool: "computer", args: () => ({ action: "triple_click", x: 520, y: 320 }), words: Words.tripleClick, mode: "travel" },
    { id: "computer-scroll-up", tool: "computer", args: () => ({ action: "scroll", x: 400, y: 300, amount: -2 }), words: Words.scrollUp, mode: "travel" },
    { id: "computer-right_click", tool: "computer", args: () => ({ action: "right_click", x: 540, y: 340 }), words: Words.rightClick, mode: "travel" },
    { id: "computer-scroll-down", tool: "computer", args: () => ({ action: "scroll", x: 400, y: 300, amount: 2 }), words: Words.scrollDown, mode: "travel" },
    { id: "computer-wait", tool: "computer", args: () => ({ action: "wait", ms: 2000 }), words: Words.wait("2"), mode: "stay" },
    { id: "scroll-to-go", tool: "scroll", args: (c) => ({ target: ref(c, "Go button") }), words: Words.scrollToElement, mode: "stay" },
    {
      id: "screenshot",
      tool: "screenshot",
      args: () => ({}),
      words: null,
      mode: "unchanged",
      after: (ctx, result) => {
        const id = (result.json as { imageId?: string } | undefined)?.imageId;
        if (id !== undefined) ctx.imageId = id;
      },
    },
    { id: "upload_image", tool: "upload_image", args: (c) => ({ imageId: c.imageId ?? "img_missing000", ref: ctxRef(c, "Attachment") }), words: Words.uploadImage, mode: "rest" },
    { id: "screenshot-region", tool: "screenshot", args: () => ({ region: { x: 0, y: 0, width: 200, height: 150 } }), words: null, mode: "unchanged" },
    { id: "file_upload", tool: "file_upload", args: (c) => ({ ref: ctxRef(c, "Attachment"), paths: [c.uploadFile] }), words: Words.fileUpload, mode: "rest" },
    { id: "computer-screenshot", tool: "computer", args: () => ({ action: "screenshot" }), words: null, mode: "unchanged" },
    { id: "tabs_context", tool: "tabs_context", args: () => ({}), words: null, mode: "unchanged" },
    { id: "resize_window", tool: "resize_window", args: (c) => ({ width: c.outer.w, height: c.outer.h }), words: Words.resize, mode: "rest" },
    { id: "read_page-interactive", tool: "read_page", args: () => ({ filter: "interactive" }), words: Words.readPage, mode: "stay" },
    { id: "viewport-set", tool: "viewport", args: () => ({ action: "set", width: 1000, height: 700 }), words: Words.resize, mode: "rest" },
    { id: "downloads_context", tool: "downloads_context", args: () => ({}), words: null, mode: "unchanged" },
    { id: "get_page_text-2", tool: "get_page_text", args: () => ({}), words: Words.readPageText, mode: "stay" },
    { id: "viewport-reset", tool: "viewport", args: () => ({ action: "reset" }), words: Words.resize, mode: "rest" },
    // The navigations last: they replace the document, and refs do not survive them.
    {
      id: "navigate-url",
      tool: "navigate",
      args: () => ({ url: `${SITE}${MAIN_PATH}?step=1` }),
      words: Words.navigate(HOST),
      mode: "rest",
      replacesDocument: true,
    },
    { id: "navigate-back", tool: "navigate", args: () => ({ direction: "back" }), words: Words.back, mode: "rest", replacesDocument: true },
    { id: "navigate-forward", tool: "navigate", args: () => ({ direction: "forward" }), words: Words.forward, mode: "rest", replacesDocument: true },
  ];
}

/** `ref(...)` for the tools that take a bare ref string. */
function ctxRef(ctx: RowContext, name: string): string {
  return ctx.refs[name] ?? `missing-ref:${name}`;
}

// =============================================================================================
// The captured-image scenario (live-6)
// =============================================================================================

type Helper = Page;
type Check = ReturnType<typeof checker>;

async function captureScenario(input: {
  tab: Tab;
  label: string;
  scenario: "rest" | "pointing";
  live: McpHarnessClient;
  helper: Helper;
  testInfo: TestInfo;
  check: Check;
  captures: unknown[];
}): Promise<void> {
  const { tab, label, scenario, live, helper, testInfo, check, captures } = input;
  const { page, tabId } = tab;
  const name = `${label}-${scenario}`;

  // Put the marks up. `rest`: a viewport call leaves pointer and caption at the rest spot, and nothing
  // fades there, so the caption is certainly up for every capture. `pointing`: a click, whose caption
  // fades about a second after arrival - the capture follows at once and records whether it had faded.
  const point = { x: 900, y: 560 };
  if (scenario === "rest") await live.callTool("viewport", { tabId, action: "set", width: 1280, height: 800 });
  else await live.callTool("computer", { tabId, action: "left_click", x: point.x, y: point.y });
  await stillPointer(page, 450);
  await showTab(page);

  const kinds: Array<{
    id: string;
    run: () => Promise<ToolCallResult>;
    region: { x: number; y: number; width: number; height: number } | null;
  }> = [];
  const regionAround =
    scenario === "rest"
      ? { x: 0, y: 800 - 140, width: 420, height: 140 }
      : { x: point.x - 120, y: point.y - 60, width: 420, height: 160 };
  kinds.push({ id: "screenshot-whole", run: () => live.callTool("screenshot", { tabId }), region: null });
  kinds.push({ id: "screenshot-region", run: () => live.callTool("screenshot", { tabId, region: regionAround }), region: regionAround });
  kinds.push({ id: "computer-screenshot", run: () => live.callTool("computer", { tabId, action: "screenshot" }), region: null });

  for (const kind of kinds) {
    const captureName = `${name}-${kind.id}`;
    const entry: Record<string, unknown> = { capture: captureName };
    captures.push(entry);

    // Where the marks are, now.
    const state = await settle(() => page.evaluate(readPageState));
    const { w: vw, h: vh } = state.viewport;
    const rects = markRects(state, vw, vh);
    entry["viewport"] = state.viewport;
    entry["captionFadedAtCapture"] = state.caption?.faded ?? null;
    entry["cssRects"] = rects;

    // The control: the same page, same instant, photographed by the runner with the marks up.
    let control: ProbeResult | null = null;
    try {
      const png = await page.screenshot({ scale: "css", type: "png" });
      await writeFile(testInfo.outputPath(`live-6-${captureName}-control.png`), png);
      control = await probePixels(helper, { data: png.toString("base64"), mimeType: "image/png" }, rects.map((r) => ({ ...r })));
    } catch (error) {
      entry["controlError"] = String(error);
    }
    entry["control"] = control;

    // The capture itself.
    const mark = await lastLogN(page);
    const startedAt = Date.now();
    const result = await kind.run();
    const returnedAt = Date.now();
    const events = (await readLog(page)).filter((e) => (e["n"] as number) > mark);
    const after = await settle(() => page.evaluate(readPageState));
    await saveImages(testInfo, `live-6-${captureName}-returned`, result.images);

    const image = result.images[0];
    const answer = (result.json ?? {}) as { width?: number; height?: number; frame?: { width: number; height: number } };
    entry["isError"] = result.isError;
    entry["answer"] = { width: answer.width, height: answer.height, frame: answer.frame };
    check.ok(!result.isError && image !== undefined, `${captureName}: no image came back: ${result.text.slice(0, 200)}`);

    // Pixels.
    if (image !== undefined) {
      const frame = answer.frame ?? { width: vw, height: vh };
      const origin = kind.region ?? { x: 0, y: 0, width: frame.width, height: frame.height };
      const scale = (answer.width ?? 0) > 0 ? (answer.width as number) / origin.width : 1;
      const mapped = rects
        .map((r) => ({
          name: r.name,
          x: (r.x - origin.x) * scale,
          y: (r.y - origin.y) * scale,
          w: r.w * scale,
          h: r.h * scale,
        }))
        .filter((r) => r.x + r.w > 0 && r.y + r.h > 0 && r.x < origin.width * scale && r.y < origin.height * scale);
      const probe = await probePixels(helper, image, mapped);
      entry["returned"] = probe;
      entry["scale"] = scale;
      check.ok(frame.width === vw, `${captureName}: the picture's frame is ${frame.width} wide but the page is ${vw} (points would be misread)`);
      for (const rectResult of probe.rects) {
        const detectable = control?.rects.find((c) => c.name === rectResult.name)?.bad ?? 0;
        if (detectable > 0) {
          check.ok(
            rectResult.bad === 0,
            `FR-509 ${captureName}: ${rectResult.bad}/${rectResult.total} pixels at "${rectResult.name}" differ from the page background (max deviation ${rectResult.max}) - a mark is in the returned image`,
          );
        }
      }
      const proven = probe.rects.filter((r) => (control?.rects.find((c) => c.name === r.name)?.bad ?? 0) > 0).map((r) => r.name);
      entry["placesProvenByControl"] = proven;
      check.ok(proven.length > 0, `${captureName}: the control screenshot showed no mark at any probed place, so the pixel check proves nothing`);
    }

    // Timing: hidden, then shown again within 500 ms of the call returning.
    const hiddenEvents = events.filter((e) => e["k"] === "hidden");
    const perKind: Record<string, { on: number | null; off: number | null }> = {};
    for (const markKind of ["pointer", "caption", "pill", "glow"]) {
      const on = hiddenEvents.find((e) => e["el"] === markKind && e["on"] === true);
      const off = hiddenEvents.find((e) => e["el"] === markKind && e["on"] === false);
      perKind[markKind] = { on: (on?.["t"] as number | undefined) ?? null, off: (off?.["t"] as number | undefined) ?? null };
      check.ok(on !== undefined, `FR-509 ${captureName}: the ${markKind} was never hidden for the capture`);
      check.ok(off !== undefined, `FR-509 ${captureName}: the ${markKind} was never shown again after the capture`);
      if (on !== undefined && off !== undefined) {
        const offT = off["t"] as number;
        check.ok(offT - returnedAt <= 500, `SC-223 ${captureName}: the ${markKind} came back ${offT - returnedAt} ms after the call returned (limit 500)`);
        check.ok(offT - (on["t"] as number) < 3000, `${captureName}: the ${markKind} stayed hidden ${offT - (on["t"] as number)} ms (safety limit 3000)`);
        check.ok((on["t"] as number) >= startedAt - 50, `${captureName}: the ${markKind} was hidden before the call began`);
      }
    }
    entry["hiddenAndShown"] = perKind;
    entry["callMs"] = returnedAt - startedAt;
    const lingering = (await settle(() => page.evaluate(() => document.querySelectorAll("[data-hallpass-hidden]").length)));
    entry["marksStillHiddenAfter"] = lingering;
    check.ok(lingering === 0, `${captureName}: ${lingering} marks still carry data-hallpass-hidden after the call`);
    check.ok(after.pointer !== null && !after.pointer.hidden && after.pointer.opacity > 0.9, `${captureName}: the pointer is not visible again after the capture`);
    check.ok(after.pill !== null && !after.pill.hidden && after.pill.opacity > 0.9, `${captureName}: the pill is not visible again after the capture`);
    check.ok(after.glow !== null && !after.glow.hidden && after.glow.opacity > 0.3, `${captureName}: the glow is not visible again after the capture`);
    if (after.caption !== null && !after.caption.faded) {
      check.ok(!after.caption.hidden && after.caption.opacity > 0.9, `${captureName}: the caption is not visible again after the capture`);
    }

    // And painted: a runner screenshot after the capture shows the marks again (rest scenario only,
    // where nothing fades or moves in between).
    if (scenario === "rest") {
      try {
        const png = await page.screenshot({ scale: "css", type: "png" });
        const back = await probePixels(helper, { data: png.toString("base64"), mimeType: "image/png" }, rects.map((r) => ({ ...r })));
        entry["afterControl"] = back;
        const pointerBack = back.rects.find((r) => r.name === "pointer");
        check.ok((pointerBack?.bad ?? 0) > 0, `${captureName}: the runner's screenshot right after the capture does not show the pointer again`);
        await sleep(0);
      } catch (error) {
        entry["afterControlError"] = String(error);
      }
    }
  }
}

type CssRect = { name: string; x: number; y: number; w: number; h: number };

/** Where each mark is drawn, in CSS pixels, with room for the arrow's outline and the shadows. */
function markRects(state: PageState, vw: number, vh: number): CssRect[] {
  const rects: CssRect[] = [];
  const pad = (name: string, box: Box | undefined, by: number): void => {
    if (!box || box.width <= 0 || box.height <= 0) return;
    rects.push({ name, x: Math.max(0, box.left - by), y: Math.max(0, box.top - by), w: box.width + 2 * by, h: box.height + 2 * by });
  };
  pad("pointer", state.pointer?.box, 10);
  pad("caption", state.caption?.box, 6);
  pad("pill", state.pill?.box, 6);
  rects.push({ name: "glow-left", x: 0, y: 0, w: 12, h: vh });
  rects.push({ name: "glow-bottom", x: 0, y: vh - 12, w: vw, h: 12 });
  rects.push({ name: "glow-top", x: 0, y: 0, w: vw, h: 10 });
  return rects;
}

type ProbeResult = {
  width: number;
  height: number;
  rects: Array<{ name: string; total: number; bad: number; max: number }>;
};

/** Decodes an image in the extension page and counts the pixels in each rectangle that are not page-white. */
async function probePixels(
  helper: Page,
  image: { data: string; mimeType: string },
  rects: Array<{ name: string; x: number; y: number; w: number; h: number }>,
): Promise<ProbeResult> {
  return helper.evaluate(
    async ({ data, mimeType, rects: wanted }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      const tolerance = 16;
      const out: Array<{ name: string; total: number; bad: number; max: number }> = [];
      for (const rect of wanted) {
        const x0 = Math.max(0, Math.floor(rect.x));
        const y0 = Math.max(0, Math.floor(rect.y));
        const x1 = Math.min(bitmap.width, Math.ceil(rect.x + rect.w));
        const y1 = Math.min(bitmap.height, Math.ceil(rect.y + rect.h));
        if (x1 <= x0 || y1 <= y0) continue;
        const pixels = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let bad = 0;
        let max = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const deviation = Math.max(255 - (pixels[i] ?? 0), 255 - (pixels[i + 1] ?? 0), 255 - (pixels[i + 2] ?? 0));
          if (deviation > tolerance) bad += 1;
          if (deviation > max) max = deviation;
        }
        out.push({ name: rect.name, total: pixels.length / 4, bad, max });
      }
      return { width: bitmap.width, height: bitmap.height, rects: out };
    },
    { data: image.data, mimeType: image.mimeType, rects },
  );
}

// =============================================================================================
// Session and tab plumbing, copied from the sibling journeys
// =============================================================================================

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };
type Session = {
  context: BrowserContext;
  client: McpHarnessClient;
  settings: SettingsPageDriver;
  modeSet: boolean;
  close: () => Promise<void>;
};
type Tab = { tabId: number; page: Page; url: string };
type Point = { x: number; y: number };

async function openSession(fixtures: Fixtures): Promise<Session> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  // Deliberately a fixture the agent never visits: the owner's own tab must never be on a page the
  // assertions read.
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });

  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });
  return {
    context: extensionContext,
    client,
    settings,
    modeSet: false,
    close: () => client.close(),
  };
}

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
async function call(session: Session, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await session.client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${session.client.stderr()}`).toBe(false);
  return result.json;
}

/** Opens one fixture page as a tab of the session, with the probe on it and the tab in front. */
async function useTab(session: Session, path: string): Promise<Tab> {
  const url = `${SITE}${path}`;
  const created = (await call(session, "tabs_create", { url })) as { tabId: number };
  const page = await agentPage(session.context, url);
  await page.addInitScript(installProbe);
  await settle(() => page.waitForLoadState("load"));
  await page.evaluate(installProbe);
  if (!session.modeSet) {
    await session.settings.setSiteMode(SITE, "skip-checks");
    session.modeSet = true;
  }
  await showTab(page);
  return { tabId: created.tabId, page, url };
}

/** Animation frames - and so every measurement here - run only in a visible tab. */
async function showTab(page: Page): Promise<void> {
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState), {
      timeout: 10_000,
      message: "the agent's tab is not visible (is the browser window minimized or covered?); animation frames do not run in it",
    })
    .toBe("visible");
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(context: { pages: () => Page[] }, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((candidate) => candidate.url() === url);
    if (found) return found;
    await sleep(200);
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

async function waitForViewport(page: Page, width: number, height: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })), {
      timeout: 15_000,
      message: `the page never reported a ${width}x${height} viewport`,
    })
    .toEqual({ w: width, h: height });
  await sleep(150);
}

// =============================================================================================
// The probe that runs in the agent's page, and the readers of what it keeps
// =============================================================================================

type PageBox = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type MarkState = { box: PageBox; hidden: boolean; opacity: number };
type Box = PageBox;
type PageState = {
  visibility: string;
  viewport: { w: number; h: number };
  scrollY: number;
  pointer: MarkState | null;
  caption:
    | (MarkState & {
        words: string;
        faded: boolean;
        side: string | null;
        corner: string | null;
        content: string;
        position: string;
        display: string;
      })
    | null;
  pill: MarkState | null;
  glow: MarkState | null;
  rings: number;
  styleInjected: boolean;
};

/**
 * Runs in the page (it is passed to `addInitScript` and `evaluate`, so it must stay self-contained).
 * Idempotent per document. Everything it keeps that must survive a same-origin navigation goes to
 * sessionStorage under `__hp033log`; the per-frame pointer samples stay in memory.
 */
function installProbe(): void {
  const holder = window as unknown as { __hp033?: { samples: Array<{ t: number; x: number; y: number }> } };
  if (holder.__hp033) return;
  const probe = { samples: [] as Array<{ t: number; x: number; y: number }> };
  holder.__hp033 = probe;

  const KEY = "__hp033log";
  const readLogEntries = (): Array<Record<string, unknown>> => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  };
  const push = (entry: Record<string, unknown>): void => {
    try {
      const log = readLogEntries();
      const last = log[log.length - 1];
      const n = (last && typeof last["n"] === "number" ? (last["n"] as number) : 0) + 1;
      log.push({ n, t: performance.timeOrigin + performance.now(), ...entry });
      sessionStorage.setItem(KEY, JSON.stringify(log.slice(-800)));
    } catch {
      /* storage can be unavailable on an opaque origin */
    }
  };

  const MARKS = "[data-hallpass-cursor],[data-hallpass-ring],[data-hallpass-pill],[data-hallpass-glow]";
  const kindOf = (el: Element): string =>
    el.hasAttribute("data-hallpass-cursor")
      ? "pointer"
      : el.hasAttribute("data-hallpass-words")
        ? "caption"
        : el.hasAttribute("data-hallpass-ring")
          ? "ring"
          : el.hasAttribute("data-hallpass-pill")
            ? "pill"
            : el.hasAttribute("data-hallpass-glow")
              ? "glow"
              : "other";
  const noteNode = (node: Element, sign: "+" | "-"): void => {
    const found: Element[] = node.matches(MARKS) ? [node] : [];
    found.push(...Array.from(node.querySelectorAll(MARKS)));
    for (const el of found) {
      const rect = el.getBoundingClientRect();
      const style = (el as HTMLElement).style;
      push({
        k: kindOf(el) + sign,
        hidden: el.hasAttribute("data-hallpass-hidden"),
        w: rect.width,
        h: rect.height,
        sx: Number.parseFloat(style.left),
        sy: Number.parseFloat(style.top),
      });
    }
  };

  const begin = (): void => {
    const root = document.documentElement;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          const target = record.target;
          if (record.attributeName === "data-hallpass-words") push({ k: "words", words: target.getAttribute("data-hallpass-words") ?? "" });
          else if (record.attributeName === "data-hallpass-hidden") push({ k: "hidden", el: kindOf(target), on: target.hasAttribute("data-hallpass-hidden") });
          else if (record.attributeName === "data-faded") push({ k: "faded", on: target.hasAttribute("data-faded") });
        } else if (record.type === "childList") {
          record.addedNodes.forEach((node) => {
            if (node instanceof Element) noteNode(node, "+");
          });
          record.removedNodes.forEach((node) => {
            if (node instanceof Element) noteNode(node, "-");
          });
        }
      }
    }).observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-hallpass-words", "data-hallpass-hidden", "data-faded"],
    });

    let lastMove = 0;
    window.addEventListener(
      "mousemove",
      (event) => {
        const at = performance.now();
        if (at - lastMove < 50) return;
        lastMove = at;
        push({ k: "mousemove", x: event.clientX, y: event.clientY, trusted: event.isTrusted });
      },
      true,
    );
    for (const type of ["mousedown", "click"] as const) {
      window.addEventListener(type, (event) => push({ k: type, x: event.clientX, y: event.clientY, trusted: event.isTrusted }), true);
    }

    const tick = (frameTime: number): void => {
      const el = document.querySelector("[data-hallpass-cursor]");
      if (el) {
        const rect = el.getBoundingClientRect();
        probe.samples.push({ t: performance.timeOrigin + frameTime, x: rect.left, y: rect.top });
        if (probe.samples.length > 8000) probe.samples.splice(0, 3000);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  if (document.documentElement) begin();
  else {
    const waiting = new MutationObserver(() => {
      if (!document.documentElement) return;
      waiting.disconnect();
      begin();
    });
    waiting.observe(document, { childList: true });
  }
}

/** Runs in the page: the marks as they are drawn right now. */
function readPageState(): PageState {
  const boxOf = (el: Element): PageBox => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const markOf = (el: Element | null): MarkState | null =>
    el === null
      ? null
      : { box: boxOf(el), hidden: el.hasAttribute("data-hallpass-hidden"), opacity: Number.parseFloat(getComputedStyle(el).opacity) };
  const label = document.querySelector("[data-hallpass-words]");
  const base = markOf(label);
  const caption =
    label === null || base === null
      ? null
      : {
          ...base,
          words: label.getAttribute("data-hallpass-words") ?? "",
          faded: label.hasAttribute("data-faded"),
          side: label.getAttribute("data-side"),
          corner: label.getAttribute("data-corner"),
          content: getComputedStyle(label, "::before").content,
          position: getComputedStyle(label).position,
          display: getComputedStyle(label).display,
        };
  return {
    visibility: document.visibilityState,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollY: window.scrollY,
    pointer: markOf(document.querySelector("[data-hallpass-cursor]")),
    caption,
    pill: markOf(document.querySelector("[data-hallpass-pill]")),
    glow: markOf(document.querySelector("[data-hallpass-glow]")),
    rings: document.querySelectorAll("[data-hallpass-ring]").length,
    styleInjected: document.querySelector("style[data-hallpass-cursor-style]") !== null,
  };
}

/** Runs in the page: the per-frame pointer samples from `since` (epoch ms) on. */
function readSamples(since: number): Array<{ t: number; x: number; y: number }> {
  const holder = window as unknown as { __hp033?: { samples: Array<{ t: number; x: number; y: number }> } };
  return (holder.__hp033?.samples ?? []).filter((sample) => sample.t >= since);
}

/**
 * Runs in the page: looks for the caption as shown (the whole string) with the page's own search, its
 * text and its selection (FR-504, SC-222). A single word of it is ordinary page vocabulary ("page",
 * "text" are in the fixture's style and script source and in any page's text), so the words are
 * searched too but only RECORDED (`...Words`): the criterion is the caption, not its vocabulary.
 * `textContent` is read without <style>, <script> and <noscript>, which hold source, not shown text.
 */
function searchForWords([caption, words]: readonly [string, string[]]): {
  windowFindCaption: boolean;
  innerTextHasCaption: boolean;
  textContentHasCaption: boolean;
  selectionHasCaption: boolean;
  recordedOnly: { windowFindWords: Record<string, boolean>; innerTextWords: string[]; textContentWords: string[]; selectionWords: string[] };
} {
  const finder = (window as unknown as { find?: (...args: unknown[]) => boolean }).find;
  // window.find(string, caseSensitive, backwards, wrapAround) - false when the text is not in the document.
  const find = (needle: string): boolean =>
    typeof finder === "function" ? finder.call(window, needle, true, false, true) === true : false;
  const windowFindCaption = find(caption);
  const windowFindWords: Record<string, boolean> = {};
  for (const word of words) windowFindWords[word] = find(word);
  const inner = document.body.innerText;
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  for (const source of Array.from(clone.querySelectorAll("style, script, noscript"))) source.remove();
  const content = clone.textContent ?? "";
  document.execCommand("selectAll");
  const selected = String(window.getSelection() ?? "");
  window.getSelection()?.removeAllRanges();
  return {
    windowFindCaption,
    innerTextHasCaption: inner.includes(caption),
    textContentHasCaption: content.includes(caption),
    selectionHasCaption: selected.includes(caption),
    recordedOnly: {
      windowFindWords,
      innerTextWords: words.filter((word) => inner.includes(word)),
      textContentWords: words.filter((word) => content.includes(word)),
      selectionWords: words.filter((word) => selected.includes(word)),
    },
  };
}

async function readLog(page: Page): Promise<Array<Record<string, unknown>>> {
  return settle(() =>
    page.evaluate(() => {
      try {
        return JSON.parse(sessionStorage.getItem("__hp033log") ?? "[]") as Array<Record<string, unknown>>;
      } catch {
        return [];
      }
    }),
  );
}

async function lastLogN(page: Page): Promise<number> {
  const log = await readLog(page);
  const last = log[log.length - 1];
  return last && typeof last["n"] === "number" ? (last["n"] as number) : 0;
}

/** Reads the page until the pointer has stopped moving (two equal reads), at most `maxMs`. */
async function stillPointer(page: Page, maxMs: number): Promise<PageState> {
  let state = await settle(() => page.evaluate(readPageState));
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(70);
    const next = await settle(() => page.evaluate(readPageState));
    const same = sameSpot(tipOf(next), tipOf(state), 0.05);
    state = next;
    if (same) break;
  }
  return state;
}

/** Polls the caption's `data-faded` and returns how long after `returnedAt` it appeared, or null. */
async function watchFade(page: Page, returnedAt: number): Promise<number | null> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const state = await settle(() => page.evaluate(readPageState));
    if (state.caption?.faded === true) return Date.now() - returnedAt;
    await sleep(40);
  }
  return null;
}

// =============================================================================================
// Motion analysis
// =============================================================================================

type Sample = { t: number; x: number; y: number };

type Travel = {
  start: Point | null;
  end: Point | null;
  startT: number | null;
  endT: number | null;
  durationMs: number | null;
  maxBowPx: number;
  midBowPx: number;
  overshootPx: number;
  samples: number;
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The move in a run of per-frame samples: it starts at the last frame before the tip leaves where it
 * was, and ends at the first frame that sits on the final position for good. Both ends are frame
 * quantised, hence the sampling slack in the assertions.
 */
function analyseTravel(samples: Sample[], target: Point): Travel {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) {
    return { start: null, end: null, startT: null, endT: null, durationMs: null, maxBowPx: 0, midBowPx: 0, overshootPx: 0, samples: 0 };
  }
  const start = { x: first.x, y: first.y };
  const end = { x: last.x, y: last.y };
  let leaving = samples.findIndex((s) => distance(s, start) > 0.05);
  if (leaving < 0) leaving = samples.length - 1;
  const startT = (samples[Math.max(0, leaving - 1)] ?? first).t;
  let lastOff = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const s = samples[index];
    if (s && distance(s, end) > 0.05) lastOff = index;
  }
  const endT = (samples[Math.min(samples.length - 1, lastOff + 1)] ?? last).t;
  const chord = distance(start, target);
  let maxBow = 0;
  let midBow = 0;
  let overshoot = 0;
  if (chord > 1) {
    const ux = (target.x - start.x) / chord;
    const uy = (target.y - start.y) / chord;
    const middleT = startT + (endT - startT) / 2;
    let nearest = Number.POSITIVE_INFINITY;
    for (const s of samples) {
      if (s.t < startT || s.t > endT) continue;
      const along = (s.x - start.x) * ux + (s.y - start.y) * uy;
      const aside = Math.abs((s.x - start.x) * -uy + (s.y - start.y) * ux);
      maxBow = Math.max(maxBow, aside);
      overshoot = Math.max(overshoot, along - chord);
      if (Math.abs(s.t - middleT) < nearest) {
        nearest = Math.abs(s.t - middleT);
        midBow = aside;
      }
    }
  }
  return { start, end, startT, endT, durationMs: endT - startT, maxBowPx: maxBow, midBowPx: midBow, overshootPx: overshoot, samples: samples.length };
}

type ClickMeasure = {
  point: Point;
  isError: boolean;
  samples: number;
  durationMs: number | null;
  distancePx: number | null;
  maxBowPx: number;
  midBowPx: number;
  overshootPx: number;
  endError: number | null;
  rings: number;
  ringAfterArrivalMs: number | null;
  ringLifetimeMs: number | null;
  firstEventAfterArrivalMs: number | null;
  clickAfterArrivalMs: number | null;
  pressAfterTravelStartMs: number | null;
  callMs: number;
};

function measureClick(input: {
  point: Point;
  startedAt: number;
  returnedAt: number;
  samples: Sample[];
  events: Array<Record<string, unknown>>;
  isError: boolean;
}): ClickMeasure {
  const { point, startedAt, returnedAt, samples, events, isError } = input;
  const travel = analyseTravel(samples, point);
  const rings = events.filter((e) => e["k"] === "ring+");
  const ringRemoved = events.filter((e) => e["k"] === "ring-");
  const firstMove = events.find((e) => e["k"] === "mousemove");
  const down = events.find((e) => e["k"] === "mousedown");
  const clicked = events.find((e) => e["k"] === "click");
  const since = (value: unknown, from: number | null): number | null =>
    typeof value === "number" && from !== null ? value - from : null;
  const firstRing = rings[0];
  return {
    point,
    isError,
    samples: travel.samples,
    durationMs: travel.durationMs,
    distancePx: travel.start === null ? null : distance(travel.start, point),
    maxBowPx: travel.maxBowPx,
    midBowPx: travel.midBowPx,
    overshootPx: travel.overshootPx,
    endError: travel.end === null ? null : distance(travel.end, point),
    rings: rings.length,
    ringAfterArrivalMs: since(firstRing?.["t"], travel.endT),
    ringLifetimeMs:
      firstRing && ringRemoved[0] && typeof firstRing["t"] === "number" && typeof ringRemoved[0]["t"] === "number"
        ? (ringRemoved[0]["t"] as number) - (firstRing["t"] as number)
        : null,
    firstEventAfterArrivalMs: since(firstMove?.["t"] ?? down?.["t"], travel.endT),
    clickAfterArrivalMs: since(clicked?.["t"], travel.endT),
    pressAfterTravelStartMs: since(down?.["t"], travel.startT),
    callMs: returnedAt - startedAt,
  };
}

// =============================================================================================
// Small things
// =============================================================================================

function checker(): { ok: (condition: boolean, message: string) => boolean; verify: () => void } {
  const failures: string[] = [];
  return {
    ok(condition: boolean, message: string): boolean {
      if (!condition) failures.push(message);
      return condition;
    },
    verify(): void {
      expect(failures, `${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`).toEqual([]);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a page read, retrying while the page is changing documents under it. */
async function settle<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      last = error;
      await sleep(150);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function tipOf(state: PageState): Point | null {
  return state.pointer === null ? null : { x: state.pointer.box.left, y: state.pointer.box.top };
}

function sameSpot(a: Point | null, b: Point | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b;
  return distance(a, b) <= tolerance;
}

function fmt(point: Point | null): string {
  return point === null ? "none" : `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;
}

function summarise(state: PageState): Record<string, unknown> {
  return {
    viewport: state.viewport,
    pointer: tipOf(state),
    words: state.caption?.words ?? null,
    faded: state.caption?.faded ?? null,
    captionOpacity: state.caption?.opacity ?? null,
    captionBox: state.caption?.box ?? null,
    side: state.caption?.side ?? null,
  };
}

function isSubsequence(wanted: string[], seen: string[]): boolean {
  let at = 0;
  for (const item of seen) if (item === wanted[at]) at += 1;
  return at === wanted.length;
}

/** Arguments for the evidence file: a ref or an image id is a handle, not something to read. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (key, value) => (key === "imageId" || key === "paths" ? "(omitted)" : value))) as Record<string, unknown>;
}

function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

async function writeEvidence(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await testInfo.attach(name, { path, contentType: "application/json" });
}

/** The page as the owner sees it, marks included (the runner's own screenshot, not the agent's). */
async function saveShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  try {
    await page.screenshot({ path: testInfo.outputPath(name), scale: "css" });
  } catch (error) {
    note(testInfo, "screenshot-failed", `${name}: ${String(error)}`);
  }
}

/** The images a tool returned to the agent, as files. */
async function saveImages(testInfo: TestInfo, base: string, images: ToolCallResult["images"]): Promise<void> {
  for (const [index, image] of images.entries()) {
    const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
    await writeFile(testInfo.outputPath(`${base}-${index + 1}.${extension}`), Buffer.from(image.data, "base64"));
  }
}
