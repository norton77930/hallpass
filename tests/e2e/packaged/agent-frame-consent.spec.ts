import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, FrameLocator, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import {
  copyFor,
  localeFromEnv,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The page's site: every fixture below is opened here. */
const SITE = "https://127.0.0.1:19443";
/**
 * The second site the fixtures frame (`__OOPIF_ORIGIN__`): another host name on the same server, so a
 * different site by full origin (D-030-2) and a real out-of-process frame.
 */
const SECOND = "https://localhost:19443";
/** Where `frame-navigating` sends its frame on `postMessage("go")` (`__CROSS_ORIGIN__`). */
const MOVED_TO = "https://127.0.0.1:19445";

/** How long "no card appeared" is watched for after a call has already answered. */
const NO_CARD_WINDOW_MS = 1_500;

/**
 * 030/T905 — consent per site for embedded frames, end to end (quickstart scenario table; SC-202..205,
 * SC-207).
 *
 * The unit tests settle the gate with a modelled browser; only a real one settles that the frame's
 * site is the browser's (an out-of-process frame on another host name, a sandboxed frame with an
 * opaque origin, inline frames that inherit), and that the card the owner reads names both sites.
 * Every decision is made by pressing the side panel's own buttons, and every "nothing reached the
 * page" claim is read from the fixture frame's own field or status line, never from the tool's answer.
 *
 * Story 4 needs the frame to move inside one window: after the card is up and before the owner
 * answers. The test sends the fixture page its own `postMessage("go")` through Playwright while the
 * card is on screen, waits until the frame shows the new page, and only then presses Allow once - so
 * the re-check right before the gesture (FR-460) is guaranteed to see the move. No hook in shipped
 * code is involved.
 *
 * The two frame-card pictures for SC-207 (`frame-card-known.png`, `frame-card-unknown.png`) are taken
 * on the panel's own CDP session and written to the run's output directory.
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (19443-19445).
 */
test.describe("agent frame consent", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("Story 1: typing into another site's frame asks for that site; Allow once types, Refuse types nothing", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      const frame = page.frameLocator("#consent-frame");
      await expect(frame.locator("#frame-field")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");
      const field = await refFor(call, tabId, frameTextbox);

      // ===== 1.1: a card for the frame's site, naming both sites; nothing typed while it is up =====
      const typing = live.callTool("type", { tabId, target: { ref: field }, text: "allowed-once", mode: "replace" });
      await waitForPrompt(panel, "consent");
      const line = await frameLine(panel);
      expect(line.kind, await panel.panelText()).toBe("site");
      expect(line.text).toContain(SECOND);
      expect(line.text).toContain(SITE);
      expect(await frame.locator("#frame-field").inputValue(), "the field changed before the owner answered").toBe("");
      await panelShot(panel, "frame-card-known.png");

      // ===== 1.2: Allow once types the text =====
      await clickInPrompt(panel, "consent", ui("agent.allowOnce"));
      const allowed = await typing;
      expect(allowed.isError, `type: ${allowed.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(frame.locator("#frame-field")).toHaveValue("allowed-once");

      // ===== 1.2 / 1.4: the next action in that frame asks again; Refuse types nothing and names the site =====
      const again = live.callTool("type", { tabId, target: { ref: field }, text: "refused", mode: "replace" });
      await waitForPrompt(panel, "consent");
      expect((await frameLine(panel)).text).toContain(SECOND);
      await clickInPrompt(panel, "consent", ui("agent.refuse"));
      const refused = await again;
      expect(refused.isError, refused.text).toBe(true);
      const answer = answerOf(refused) as { outcome?: string; reason?: string; hint?: string };
      expect(answer, refused.text).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      expect(answer.hint ?? "", "the refusal does not name the frame's site").toContain(SECOND);
      await expect(frame.locator("#frame-field")).toHaveValue("allowed-once");
      await expectNoPrompt(panel, "a card stayed up after Refuse");

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE, SECOND]);
      await client?.close();
    }
  });

  test("Story 1.3: Allow always stores the frame's site only, and that site then decides inside the frame", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      const frame = page.frameLocator("#consent-frame");
      await expect(frame.locator("#frame-field")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");
      const field = await refFor(call, tabId, frameTextbox);

      const typing = live.callTool("type", { tabId, target: { ref: field }, text: "always", mode: "replace" });
      await waitForPrompt(panel, "consent");
      expect((await frameLine(panel)).text).toContain(SECOND);
      await clickInPrompt(panel, "consent", ui("agent.allowAlways"));
      const typed = await typing;
      expect(typed.isError, `type: ${typed.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(frame.locator("#frame-field")).toHaveValue("always");

      // The site list shows the frame's site as its own row in skip-checks; the page's site is unchanged.
      await expect.poll(() => settings.siteMode(SECOND), { timeout: 15_000 }).toBe("skip-checks");
      expect(await settings.siteMode(SITE)).toBe("skip-checks");

      // 1.5: with the page's site back at ask, the frame's own skip-checks decides a click inside it.
      await settings.setSiteMode(SITE, "ask");
      const button = await refFor(call, tabId, (node) => node.role === "button" && node.name === "Frame action");
      await actWithoutCard(panel, live, "click", { tabId, target: { ref: button } });
      await expect(frame.locator("#frame-status")).toHaveText("clicked");
      expect(await settings.siteMode(SECOND)).toBe("skip-checks");

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE, SECOND]);
      await client?.close();
    }
  });

  test("Story 2: a coordinate click over the frame asks for the frame's site; outside frames the page's site decides", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      const frame = page.frameLocator("#consent-frame");
      await expect(frame.locator("#frame-button")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");

      const over = await centreOf(frame.locator("#frame-button"));
      const clicking = live.callTool("computer", { tabId, action: "left_click", x: over.x, y: over.y });
      await waitForPrompt(panel, "consent");
      const line = await frameLine(panel);
      // Soft, so the rest of the story (nothing before the answer, the outside click) is still observed.
      expect.soft(line.kind, `point ${JSON.stringify(over)}\n${await panel.panelText()}`).toBe("site");
      expect.soft(line.text).toContain(SECOND);
      expect(await frame.locator("#frame-status").textContent(), "the click landed before the owner answered").toBe(
        "not clicked",
      );
      await clickInPrompt(panel, "consent", ui("agent.allowOnce"));
      const clicked = await clicking;
      expect(clicked.isError, `computer: ${clicked.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(frame.locator("#frame-status")).toHaveText("clicked");

      // A point outside every frame: the page's own skip-checks decides, no card.
      const outside = await centreOf(page.locator("#top-heading"));
      await actWithoutCard(panel, live, "computer", { tabId, action: "left_click", x: outside.x, y: outside.y });

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE, SECOND]);
      await client?.close();
    }
  });

  test("Story 3: a sandboxed frame is an unknown site without Allow always; srcdoc and about:blank follow the page", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      // ===== 3.3: sandboxed (opaque origin) - unknown site, Allow once and Refuse only =====
      const tabId = await openTab(call, `${SITE}/frame-sandboxed`);
      const sandboxedPage = await agentPage(extensionContext, `${SITE}/frame-sandboxed`);
      const sandboxed = sandboxedPage.frameLocator("#sandboxed-frame");
      await expect(sandboxed.locator("#frame-field")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");
      const sandboxedField = await refFor(call, tabId, frameTextbox);

      const typing = live.callTool("type", { tabId, target: { ref: sandboxedField }, text: "sandboxed", mode: "replace" });
      await waitForPrompt(panel, "consent");
      const line = await frameLine(panel);
      expect(line.kind, await panel.panelText()).toBe("unknown");
      expect(line.text).toContain(SITE);
      expect(await promptButtons(panel, "consent")).toEqual(
        expect.arrayContaining([ui("agent.allowOnce"), ui("agent.refuse")]),
      );
      expect(await promptButtons(panel, "consent"), "an unknown site's card offers Allow always").not.toContain(
        ui("agent.allowAlways"),
      );
      expect(await sandboxed.locator("#frame-field").inputValue()).toBe("");
      await panelShot(panel, "frame-card-unknown.png");
      await clickInPrompt(panel, "consent", ui("agent.refuse"));
      const refused = await typing;
      expect(refused.isError, refused.text).toBe(true);
      expect(answerOf(refused), refused.text).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      expect((answerOf(refused) as { hint?: string }).hint ?? "").toContain("could not be established");
      expect(await sandboxed.locator("#frame-field").inputValue()).toBe("");
      await expectNoPrompt(panel, "a card stayed up after Refuse");

      // ===== 3.2: srcdoc and about:blank frames inherit the page's site, so skip-checks types without a card =====
      for (const [path, frameId] of [
        ["frame-srcdoc", "#srcdoc-frame"],
        ["frame-blank", "#blank-frame"],
      ] as const) {
        await call("navigate", { tabId, url: `${SITE}/${path}` });
        const page = await agentPage(extensionContext, `${SITE}/${path}`);
        const inherited = page.frameLocator(frameId);
        await expect(inherited.locator("#frame-field")).toBeVisible();
        const ref = await refFor(call, tabId, frameTextbox);
        await actWithoutCard(panel, live, "type", { tabId, target: { ref }, text: `inherited-${path}`, mode: "replace" });
        await expect(inherited.locator("#frame-field")).toHaveValue(`inherited-${path}`);
      }

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE]);
      await client?.close();
    }
  });

  test("Story 4: a frame that moves between Allow once and the gesture gets nothing, and the agent is told it moved", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-navigating`);
      const page = await agentPage(extensionContext, `${SITE}/frame-navigating`);
      const frame = page.frameLocator("#moving-frame");
      await expect(frame.locator("#frame-button")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");

      // A coordinate click: the re-check before the gesture walks the point again (FR-460).
      const over = await centreOf(frame.locator("#frame-button"));
      const clicking = live.callTool("computer", { tabId, action: "left_click", x: over.x, y: over.y });
      await waitForPrompt(panel, "consent");
      // Soft, so the move and its answer are still observed when the card names the frame otherwise.
      expect.soft((await frameLine(panel)).text, `point ${JSON.stringify(over)}`).toContain(SECOND);

      // The frame moves while the card is up, and has finished moving before the owner answers.
      await page.evaluate(() => window.postMessage("go", "*"));
      await expect(frame.locator("#frame-heading")).toHaveText("Navigated frame", { timeout: 15_000 });
      expect(page.frames().some((child) => child.url().startsWith(`${MOVED_TO}/frame-navigated`))).toBe(true);

      await clickInPrompt(panel, "consent", ui("agent.allowOnce"));
      const moved = await clicking;
      expect(moved.isError, moved.text).toBe(true);
      const answer = answerOf(moved) as { outcome?: string; hint?: string };
      expect(answer, moved.text).toMatchObject({ outcome: "stale" });
      expect(answer.hint ?? "", moved.text).toContain("moved to another site");
      expect.soft(answer.hint ?? "", moved.text).toContain(SECOND);
      // Nothing reached the new page.
      await expectStill(frame.locator("#frame-status"), "not clicked");

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE]);
      await client?.close();
    }
  });

  test("Story 5: read_page names each frame's site and marks the other site's refs; a same-site page reads as before", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      await expect(page.frameLocator("#consent-frame").locator("#frame-field")).toBeVisible();

      const read = (await call("read_page", { tabId, filter: "all" })) as ReadPage;
      const frames = read.frames ?? [];
      const top = frames.find((entry) => entry.frame === "0");
      const child = frames.find((entry) => entry.url.startsWith(`${SECOND}/frame-consent-child`));
      expect(top?.site, JSON.stringify(frames)).toBe(SITE);
      expect(child?.site, JSON.stringify(frames)).toBe(SECOND);
      const inFrame = read.nodes.filter((node) => node.frame === child?.frame && node.ref !== undefined);
      expect(inFrame.map((node) => node.name), JSON.stringify(read.nodes)).toEqual(
        expect.arrayContaining(["frame-field", "Frame action"]),
      );
      expect(inFrame.every((node) => node.site === SECOND), JSON.stringify(inFrame)).toBe(true);
      const outside = read.nodes.filter((node) => (node.frame ?? "0") !== child?.frame);
      expect(outside.every((node) => node.site === undefined), JSON.stringify(outside)).toBe(true);

      const found = (await call("find", { tabId, query: "Frame action" })) as {
        matches: Array<{ ref: string; frame?: string; site?: string }>;
      };
      expect(found.matches[0]?.site, JSON.stringify(found)).toBe(SECOND);

      // A page whose only frame inherits the page's site: no reference carries a site.
      await call("navigate", { tabId, url: `${SITE}/frame-srcdoc` });
      const srcdoc = await agentPage(extensionContext, `${SITE}/frame-srcdoc`);
      await expect(srcdoc.frameLocator("#srcdoc-frame").locator("#frame-field")).toBeVisible();
      const same = (await call("read_page", { tabId, filter: "all" })) as ReadPage;
      expect(same.nodes.some(frameTextbox), JSON.stringify(same.nodes)).toBe(true);
      expect(same.nodes.every((node) => node.site === undefined), JSON.stringify(same.nodes)).toBe(true);
      expect((same.frames ?? []).every((entry) => entry.site === SITE), JSON.stringify(same.frames)).toBe(true);

      // Reading never asked the owner anything.
      await expectNoPrompt(panel, "a read raised a card");
      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE]);
      await client?.close();
    }
  });

  test("Story 6: an approved top-site plan runs step 1 on the page, and step 2 in the frame asks", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      const frame = page.frameLocator("#consent-frame");
      await expect(frame.locator("#frame-field")).toBeVisible();
      await settings.setSiteMode(SITE, "follow-a-plan");
      const heading = await refFor(call, tabId, (node) => node.role === "heading" && node.name === "Frame consent");
      const field = await refFor(call, tabId, frameTextbox);

      const batch = live.callTool("browser_batch", {
        tabId,
        steps: [
          { tool: "click", args: { target: { ref: heading } } },
          { tool: "type", args: { target: { ref: field }, text: "planned", mode: "replace" } },
        ],
      });
      await waitForPrompt(panel, "plan");
      expect(await promptText(panel, "plan")).toContain(SITE);
      await clickInPrompt(panel, "plan", ui("agent.approvePlan"));

      // Step 2 is in the second site's frame: the page's plan does not cover it.
      await waitForPrompt(panel, "consent");
      expect((await frameLine(panel)).text).toContain(SECOND);
      expect(await frame.locator("#frame-field").inputValue()).toBe("");
      await clickInPrompt(panel, "consent", ui("agent.refuse"));
      const result = await batch;
      const results = (answerOf(result) as { results?: Array<{ outcome: string; reason?: string }> }).results ?? [];
      expect(results.map((step) => step.outcome), `${result.text}\nstderr:\n${live.stderr()}`).toEqual(["ok", "denied"]);
      expect(results[1]?.reason).toBe("owner-denied");
      await expect(frame.locator("#frame-field")).toHaveValue("");

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE]);
      await client?.close();
    }
  });

  test("Story 7: keys with no target follow focus into the frame (T908)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, settings } = await ownerSurfaces(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tabId = await openTab(call, `${SITE}/frame-consent`);
      const page = await agentPage(extensionContext, `${SITE}/frame-consent`);
      const frame = page.frameLocator("#consent-frame");
      await expect(frame.locator("#frame-field")).toBeVisible();
      await settings.setSiteMode(SITE, "skip-checks");
      const field = await refFor(call, tabId, frameTextbox);

      // ===== 7.1: a click into the frame's field is the frame's decision; Allow once gives the field focus =====
      const clicking = live.callTool("click", { tabId, target: { ref: field } });
      await waitForPrompt(panel, "consent");
      expect((await frameLine(panel)).text).toContain(SECOND);
      await clickInPrompt(panel, "consent", ui("agent.allowOnce"));
      const clicked = await clicking;
      expect(clicked.isError, `click: ${clicked.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(frame.locator("#frame-field")).toBeFocused();

      // ===== 7.2: a type with no target is decided by the frame that holds focus; Refuse types nothing =====
      const typing = live.callTool("type", { tabId, text: "abc" });
      await waitForPrompt(panel, "consent");
      const line = await frameLine(panel);
      expect(line.kind, await panel.panelText()).toBe("site");
      expect(line.text).toContain(SECOND);
      expect(line.text).toContain(SITE);
      expect(await frame.locator("#frame-field").inputValue(), "a key reached the page before the owner answered").toBe("");
      await clickInPrompt(panel, "consent", ui("agent.refuse"));
      const refused = await typing;
      expect(refused.isError, refused.text).toBe(true);
      const answer = answerOf(refused) as { outcome?: string; reason?: string; hint?: string };
      expect(answer, refused.text).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      expect(answer.hint ?? "", "the refusal does not name the frame's site").toContain(SECOND);
      await expectStill(frame.locator("#frame-field"), "", 1_500, "value");
      await expectNoPrompt(panel, "a card stayed up after Refuse");

      // The same call, answered Allow once, does type: the card was about the keys, not a broken field.
      const again = live.callTool("type", { tabId, text: "abc" });
      await waitForPrompt(panel, "consent");
      expect((await frameLine(panel)).text).toContain(SECOND);
      await clickInPrompt(panel, "consent", ui("agent.allowOnce"));
      const typed = await again;
      expect(typed.isError, `type: ${typed.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(frame.locator("#frame-field")).toHaveValue("abc");

      // ===== 7.3: focus on a field in the top document: the page's skip-checks decides, no card =====
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.type = "text";
        input.id = "top-field";
        input.setAttribute("aria-label", "top-field");
        document.body.append(input);
        input.focus();
      });
      await expect(page.locator("#top-field")).toBeFocused();
      await actWithoutCard(panel, live, "type", { tabId, text: "top" });
      await expect(page.locator("#top-field")).toHaveValue("top");
      expect(await frame.locator("#frame-field").inputValue(), "keys for the top field reached the frame").toBe("abc");

      await closeTab(extensionWorker, tabId);
    } finally {
      await forgetSites(settings, [SITE, SECOND]);
      await client?.close();
    }
  });
});

type ReadNode ={ ref?: string; role?: string; name?: string; frame?: string; site?: string };

/** The fixtures' one text field, inside the frame (`#frame-field`; read_page names it by its `name`). */
const frameTextbox = (node: ReadNode): boolean => node.role === "textbox";
type ReadPage = {
  frames?: Array<{ frame: string; parent?: string; url: string; readable: boolean; site?: string }>;
  nodes: ReadNode[];
};

/** The owner's tab with the real side panel open on it, and the settings page in its own window. */
async function ownerSurfaces(
  context: BrowserContext,
  extensionId: string,
  worker: PackagedWorker,
): Promise<{ panel: SidePanelDriver; settings: SettingsPageDriver }> {
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(permissions, "the attached browser must have apps/extension/dist/agent loaded (npm run build)").toContain(
    "nativeMessaging",
  );
  const ownerPage = context.pages()[0] ?? (await context.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  // 024 FR-385: the site modes are the settings page's.
  const settings = await openSettingsPage({ context, worker, extensionId, locale, route: "#sites" });
  return { panel, settings };
}

/** Every site this test may have stored goes back to the default, so the next test starts clean. */
async function forgetSites(settings: SettingsPageDriver, sites: string[]): Promise<void> {
  for (const site of sites) {
    const mode = await settings.siteMode(site).catch(() => null);
    if (mode !== null && mode !== "ask") await settings.revokeSite(site).catch(() => undefined);
  }
}

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
function callerFor(
  client: () => McpHarnessClient | undefined,
): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (tool, args) => {
    const live = client();
    if (!live) throw new Error("mcp-client-missing");
    const result = await live.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
    return result.json;
  };
}

async function openTab(call: (tool: string, args: Record<string, unknown>) => Promise<unknown>, url: string): Promise<number> {
  return ((await call("tabs_create", { url })) as { tabId: number }).tabId;
}

/** One live ref for a control, from a structural read of the tab. */
async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  match: (node: ReadNode) => boolean,
): Promise<string> {
  const page = (await call("read_page", { tabId, filter: "all" })) as { nodes: ReadNode[] };
  const node = page.nodes.find((candidate) => candidate.ref !== undefined && match(candidate));
  expect(node, `read_page offered no matching ref on tab ${tabId}: ${JSON.stringify(page.nodes)}`).toBeTruthy();
  return node?.ref as string;
}

/** The kinds of every question on the panel right now (`consent`, `plan`...). */
async function promptKinds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt]')].map((card)=>card.getAttribute('data-prompt'))",
  )) as string[];
}

async function waitForPrompt(panel: SidePanelDriver, kind: string, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(() => promptKinds(panel), { timeout: timeoutMs, message: `no ${kind} card appeared` })
    .toContain(kind);
}

/** No card of any kind for a bounded window; a card that does appear is reported with the panel's text. */
async function expectNoPrompt(panel: SidePanelDriver, why: string, windowMs = NO_CARD_WINDOW_MS): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const kinds = await promptKinds(panel);
    if (kinds.length > 0) throw new Error(`${why}: ${kinds.join(",")} card on the panel\n${await panel.panelText()}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function promptText(panel: SidePanelDriver, kind: string): Promise<string> {
  return (await panel.evaluatePanel(
    `document.querySelector('[data-prompt=${JSON.stringify(kind)}]')?.innerText ?? ''`,
  )) as string;
}

/** The labels of every button on one card. */
async function promptButtons(panel: SidePanelDriver, kind: string): Promise<string[]> {
  return (await panel.evaluatePanel(
    `[...(document.querySelector('[data-prompt=${JSON.stringify(kind)}]')?.querySelectorAll('button') ?? [])].map((b)=>b.textContent?.trim() ?? '')`,
  )) as string[];
}

/** The consent card's frame line (030 FR-457, FR-458): `site`, `unknown`, or none, and its words. */
async function frameLine(panel: SidePanelDriver): Promise<{ kind: string | null; text: string }> {
  return (await panel.evaluatePanel(
    "(()=>{const line=document.querySelector('[data-prompt=consent] [data-frame]');" +
      "return {kind: line?.getAttribute('data-frame') ?? null, text: line?.innerText ?? ''}})()",
  )) as { kind: string | null; text: string };
}

/** A button inside one card, so two cards sharing a word can never be confused. */
async function clickInPrompt(panel: SidePanelDriver, kind: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-prompt=${JSON.stringify(kind)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the ${kind} card\n${await panel.panelText()}`).toBe(true);
}

/**
 * Runs one call that must not raise any card, and fails the moment one appears (a card would hold the
 * call, turning the failure into a timeout that says nothing).
 */
async function actWithoutCard(
  panel: SidePanelDriver,
  client: McpHarnessClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; json: unknown }> {
  let settled = false;
  const pending = client.callTool(tool, args).finally(() => {
    settled = true;
  });
  while (!settled) {
    const kinds = await promptKinds(panel);
    if (kinds.length > 0) {
      const text = await panel.panelText();
      await panel.clickIfPresent(ui("agent.refuse"));
      await pending.catch(() => undefined);
      throw new Error(`${tool} ${JSON.stringify(args)} raised a ${kinds.join(",")} card\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await pending;
  expect(result.isError, `${tool} ${JSON.stringify(args)}: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result;
}

/** The panel as the owner sees it, from its own CDP session, into the run's output directory (SC-207). */
async function panelShot(panel: SidePanelDriver, name: string): Promise<void> {
  const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as { data?: string } | undefined)?.data;
  expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
  const saved = join(test.info().project.outputDir, name);
  writeFileSync(saved, Buffer.from(data ?? "", "base64"));
  // eslint-disable-next-line no-console -- where the reviewer finds the picture.
  console.log(`[T905] ${name} -> ${saved}`);
}

/** The viewport centre of one element (a frame's element included), as the point an agent would use. */
async function centreOf(locator: ReturnType<Page["locator"]> | ReturnType<FrameLocator["locator"]>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  expect(box, "no box for the target").toBeTruthy();
  if (!box) throw new Error("no-box");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The element keeps its text (or, for a field, its value) for a short window: a late gesture would change it. */
async function expectStill(
  locator: ReturnType<FrameLocator["locator"]>,
  text: string,
  windowMs = 1_500,
  read: "text" | "value" = "text",
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(read === "value" ? await locator.inputValue() : await locator.textContent()).toBe(text);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(context: { pages: () => Page[] }, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

/** Tidying up through the browser: a tab with a question standing holds `tabs_close` too. */
async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
}
