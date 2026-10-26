import { expect, type BrowserContext, type Page } from "@playwright/test";
import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";
import type { PackagedWorker } from "./packaged-extension.js";

/**
 * 024 T790 (R-385): the packaged settings-page driver. The standing permissions - site modes, revoke,
 * unpair, upload folders, the side-panel-agent switch, the browser's name - moved from the side panel
 * to the extension's options page `settings.html` (R-372 routes `#agents`, `#agents/<agent>`, `#sites`,
 * `#sites?site=<origin>`, `#tools`, `#connection`; port `hallpass-settings`, R-373).
 *
 * Like `side-panel-driver.ts` it only ever touches the rendered page: no private module, domain
 * function or worker internal is imported, so what a journey reads here is what the owner sees. The
 * page is opened in a window of its own that does not take the focus, so the owner's tab - and the
 * tab-scoped side panel on it - stays in front while a journey changes a permission (opening it as a
 * tab of the owner's window would hide that panel).
 */

export type SettingsSection = "agents" | "sites" | "tools" | "connection";
export type SettingsAgent = "claude-code" | "codex" | "hermes" | "deepseek";
export type SiteMode = "ask" | "follow-a-plan" | "skip-checks";

/** One agent card as rendered (FR-377): its state, the Enabled switch, the default mark, open or not. */
export type AgentCardView = {
  agent: SettingsAgent;
  state: string | null;
  enabled: boolean;
  isDefault: boolean;
  open: boolean;
  name: string;
};

export type SettingsPageDriver = {
  readonly page: Page;
  readonly locale: AppLocale;
  /** The page's text for a key, with `{name}` placeholders filled. */
  t(key: string, vars?: Record<string, string | number>): string;
  /** Resolves once the worker's first projection is on screen (the navigation is rendered). */
  waitReady(timeoutMs?: number): Promise<void>;
  /** Moves the page to a route by its hash (the page follows `hashchange`) and waits for the section. */
  goto(route: string): Promise<void>;
  section(): Promise<SettingsSection | null>;
  /** Any expression in the page (the structural surface `agent-pairing.ts` drives). */
  evaluateSettings(expression: string, userGesture?: boolean): Promise<unknown>;
  text(): Promise<string>;
  waitForText(expected: string, timeoutMs?: number): Promise<void>;
  /** The polite notice at the bottom (toast), or `null`. */
  notice(): Promise<string | null>;

  /* Sites & permissions (FR-385) */
  siteRows(): Promise<string[]>;
  /** The checked mode of a site's row, `null` when the row is not listed. */
  siteMode(site: string): Promise<SiteMode | null>;
  setSiteMode(site: string, mode: SiteMode): Promise<void>;
  /**
   * The per-site diagnostics grant (004 FR-049, `ui.agent.set-diagnostics`), looked for as a checkbox
   * on the site's settings row. Since 024 removed the panel's site row no surface renders it, so this
   * fails naming that gap rather than timing out somewhere else.
   */
  setDiagnostics(site: string, granted: boolean): Promise<void>;
  /** Revoke, then the confirmation's Revoke; resolves once the row is gone. */
  revokeSite(site: string): Promise<void>;
  /** The Undo the revoke notice offers. */
  undoRevoke(): Promise<void>;
  /** The row `#sites?site=` marked (`aria-current`), and the line above the list. */
  markedSite(): Promise<{ site: string | null; note: string | null }>;
  pairedAgents(): Promise<Array<{ agentId: string; name: string }>>;
  /** Unpair on the named outside agent's row (or the first row); resolves once the row is gone. */
  unpair(name?: string): Promise<void>;
  uploadRoots(): Promise<string[]>;
  removeUploadRoot(root: string): Promise<void>;
  /** The moves allowed for good (014), `from→to`. */
  transitions(): Promise<string[]>;
  forgetTransition(from: string, to: string): Promise<void>;

  /* Browser tools (FR-386) */
  /** The side-panel-agent consent the section shows: `granted`, `withdrawn` or `unknown`. */
  consent(): Promise<string | null>;
  setBrowserTools(on: boolean): Promise<void>;

  /* Agents (FR-376..383) */
  summary(): Promise<string>;
  agentCards(): Promise<AgentCardView[]>;
  setCardOpen(agent: SettingsAgent, open: boolean): Promise<void>;
  setAgentEnabled(agent: SettingsAgent, on: boolean): Promise<void>;
  makeDefault(agent: SettingsAgent): Promise<void>;
  /** Presses Test on an open card. */
  pressTest(agent: SettingsAgent): Promise<void>;
  /** The test line of a card: its outcome attribute and its words, or `null` when there is none. */
  testLine(agent: SettingsAgent): Promise<{ outcome: string | null; text: string } | null>;
  /** A card's words as shown (its notes, its progress, its buttons); `""` when there is no such card. */
  cardText(agent: SettingsAgent): Promise<string>;
  /** Presses the card's Download (or Try again) - the primary action of a card that needs a download. */
  pressDownload(agent: SettingsAgent): Promise<void>;
  /** The words on that button now, or `null` when the card shows none. */
  downloadLabel(agent: SettingsAgent): Promise<string | null>;
  /** Presses Cancel on a card that is downloading, opening the card first when it is collapsed. */
  pressCancel(agent: SettingsAgent): Promise<void>;
  /** The percent a card's progress bar says (open or collapsed), or `null` while Preparing or with no bar. */
  downloadPercent(agent: SettingsAgent): Promise<number | null>;
  /**
   * From now on, every notice (toast) the page shows is kept as it appears, so a journey can count how
   * often it was told something (FR-379: a finished download is told once).
   */
  recordNotices(): Promise<void>;
  notices(): Promise<string[]>;

  /* Connection & diagnostics (FR-387, FR-395) */
  browserName(): Promise<string | null>;
  renameBrowser(name: string): Promise<void>;
  /**
   * Replaces `navigator.clipboard.writeText` in this page with a recorder that resolves, so a journey
   * reads exactly what a Copy button hands the clipboard (the system clipboard needs the window's
   * focus, which this window deliberately does not take).
   */
  recordCopies(): Promise<void>;
  copies(): Promise<string[]>;
  copyDetails(): Promise<string>;
  /** Show last lines for an agent; resolves with the lines once they were read. */
  showOutput(agent: SettingsAgent, timeoutMs?: number): Promise<string>;
  copyOutput(agent: SettingsAgent): Promise<string>;

  /* Appearance (D-024-20) */
  setAppearance(change: { theme?: "system" | "light" | "dark"; language?: "system" | AppLocale }): Promise<void>;

  screenshot(path: string, fullPage?: boolean): Promise<void>;
  close(): Promise<void>;
};

const SECTION_OF_ROUTE = (route: string): SettingsSection => {
  const head = route.replace(/^#/u, "").split(/[/?]/u)[0] ?? "";
  return (["agents", "sites", "tools", "connection"] as const).find((section) => section === head) ?? "agents";
};

export function settingsUrl(extensionId: string, route = "#agents"): string {
  return `chrome-extension://${extensionId}/settings.html${route}`;
}

export function settingsText(locale: AppLocale, key: string, vars: Record<string, string | number> = {}): string {
  return lookup(key, locale).replace(/\{([a-zA-Z]+)\}/gu, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Every open settings page of this extension in the attached browser. */
export function settingsPages(context: BrowserContext, extensionId: string): Page[] {
  const prefix = `chrome-extension://${extensionId}/settings.html`;
  return context.pages().filter((page) => page.url().startsWith(prefix));
}

/**
 * Opens `settings.html#<route>` in a new unfocused window of the attached browser (or reuses the
 * settings page already open there) and waits for the worker's projection.
 */
export async function openSettingsPage(input: {
  context: BrowserContext;
  worker: PackagedWorker;
  extensionId: string;
  locale: AppLocale;
  route?: string;
}): Promise<SettingsPageDriver> {
  const { context, worker, extensionId, locale } = input;
  const route = input.route ?? "#agents";
  const existing = settingsPages(context, extensionId)[0];
  if (existing !== undefined) {
    const driver = settingsPageDriver(existing, locale);
    await driver.waitReady();
    await driver.goto(route);
    return driver;
  }
  const url = settingsUrl(extensionId, route);
  await worker.evaluate(async (target: string) => {
    await chrome.windows.create({ url: target, focused: false, width: 1280, height: 900, type: "normal" });
  }, url);
  const deadline = Date.now() + 15_000;
  let page: Page | undefined;
  while (Date.now() < deadline) {
    page = settingsPages(context, extensionId)[0];
    if (page !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (page === undefined) throw new Error(`settings-page-missing: no page at ${url} 15 s after windows.create`);
  const driver = settingsPageDriver(page, locale);
  await driver.waitReady();
  await driver.goto(route);
  return driver;
}

/** A driver over a settings page that is already open (one the product opened, for instance). */
export function settingsPageDriver(page: Page, locale: AppLocale): SettingsPageDriver {
  const t = (key: string, vars: Record<string, string | number> = {}): string => settingsText(locale, key, vars);
  const evaluateSettings = async (expression: string): Promise<unknown> => page.evaluate(expression);
  const siteRow = (site: string) => page.locator(`li.site[data-site=${JSON.stringify(site)}]`);

  const waitReady = async (timeoutMs = 30_000): Promise<void> => {
    await page.waitForFunction(() => document.querySelector(".settings-page nav.side") !== null, undefined, {
      timeout: timeoutMs,
      polling: 100,
    });
  };

  const section = async (): Promise<SettingsSection | null> =>
    (await page.evaluate(() => document.querySelector("nav.side button[aria-current=page]")?.getAttribute("data-section") ?? null)) as
      | SettingsSection
      | null;

  const goto = async (route: string): Promise<void> => {
    await page.evaluate((hash: string) => {
      if (window.location.hash !== hash) window.location.hash = hash;
    }, route);
    const wanted = SECTION_OF_ROUTE(route);
    await expect.poll(section, { timeout: 10_000, message: `settings page did not show ${wanted}` }).toBe(wanted);
  };

  const ensure = async (wanted: SettingsSection): Promise<void> => {
    await waitReady();
    if ((await section()) !== wanted) await goto(`#${wanted}`);
  };

  const text = async (): Promise<string> => page.evaluate(() => document.body.innerText);

  const waitForText = async (expected: string, timeoutMs = 30_000): Promise<void> => {
    await expect.poll(text, { timeout: timeoutMs, message: `settings page never said ${expected}` }).toContain(expected);
  };

  const notice = async (): Promise<string | null> =>
    page.evaluate(() => (document.querySelector(".toast-region .toast span") as HTMLElement | null)?.innerText ?? null);

  const siteMode = async (site: string): Promise<SiteMode | null> =>
    (await page.evaluate(
      (origin: string) =>
        (document.querySelector(`li.site[data-site=${JSON.stringify(origin)}] input[type=radio]:checked`) as HTMLInputElement | null)?.value ??
        null,
      site,
    )) as SiteMode | null;

  const cards = async (): Promise<AgentCardView[]> =>
    (await page.evaluate(() =>
      [...document.querySelectorAll("article.acard[data-agent]")].map((card) => ({
        agent: card.getAttribute("data-agent"),
        state: card.getAttribute("data-state"),
        enabled: card.getAttribute("data-enabled") === "true",
        isDefault: card.classList.contains("is-default"),
        open: card.querySelector("button.disc")?.getAttribute("aria-expanded") === "true",
        name: (card.querySelector("button.disc span:not(.chev):not(.sr-only)")?.textContent ?? "").trim(),
      })),
    )) as AgentCardView[];

  const card = (agent: SettingsAgent) => page.locator(`article.acard[data-agent=${JSON.stringify(agent)}]`);

  const recordCopies = async (): Promise<void> => {
    await page.evaluate(() => {
      const target = window as unknown as { __hallpassCopies?: string[] };
      if (target.__hallpassCopies !== undefined) return;
      target.__hallpassCopies = [];
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (value: string) => {
          target.__hallpassCopies!.push(value);
        },
      });
    });
  };
  const copies = async (): Promise<string[]> =>
    page.evaluate(() => [...((window as unknown as { __hallpassCopies?: string[] }).__hallpassCopies ?? [])]);
  const nextCopy = async (press: () => Promise<void>): Promise<string> => {
    await recordCopies();
    const before = (await copies()).length;
    await press();
    await expect.poll(async () => (await copies()).length, { timeout: 10_000, message: "nothing was copied" }).toBeGreaterThan(before);
    return (await copies())[before]!;
  };

  return {
    page,
    locale,
    t,
    waitReady,
    goto,
    section,
    evaluateSettings,
    text,
    waitForText,
    notice,

    async siteRows() {
      await ensure("sites");
      return page.evaluate(() => [...document.querySelectorAll("li.site[data-site]")].map((row) => row.getAttribute("data-site") ?? ""));
    },
    siteMode,
    async setSiteMode(site, mode) {
      await ensure("sites");
      await expect(siteRow(site), `the settings page lists no row for ${site}`).toBeVisible({ timeout: 20_000 });
      if ((await siteMode(site)) !== mode) await siteRow(site).locator(`label.${mode}`).click();
      // Back at the default, Ask, the store forgets the site, so with no session tab on it the row goes.
      await expect
        .poll(async () => (mode === "ask" && (await siteRow(site).count()) === 0 ? "ask" : siteMode(site)), { timeout: 15_000 })
        .toBe(mode);
    },
    async setDiagnostics(site, granted) {
      await ensure("sites");
      await expect(siteRow(site), `the settings page lists no row for ${site}`).toBeVisible({ timeout: 20_000 });
      const box = siteRow(site).locator("input[type=checkbox]");
      if ((await box.count()) === 0) {
        throw new Error(
          `diagnostics-grant-missing: neither the side panel nor the settings row for ${site} offers the ` +
            "diagnostics grant (004 FR-049, ui.agent.set-diagnostics) since 024 moved the site list",
        );
      }
      if ((await box.isChecked()) !== granted) await box.click();
      await expect(box).toBeChecked({ checked: granted, timeout: 15_000 });
    },
    async revokeSite(site) {
      await ensure("sites");
      await expect(siteRow(site), `the settings page lists no row for ${site}`).toBeVisible({ timeout: 20_000 });
      // The row's one quiet button is Revoke; its accessible name carries the site (016 FR-237).
      await siteRow(site).locator(":scope > button.btn.quiet").click();
      await siteRow(site).locator(".site-confirm button.danger").click();
      // The record goes. A site a live session has a tab on stays listed at its default, Ask (the
      // runtime lists those so the owner can decide before the agent acts there).
      await expect
        .poll(
          async () =>
            (await siteRow(site).count()) === 0 ||
            ((await siteRow(site).locator(".site-confirm").count()) === 0 && (await siteMode(site)) === "ask"),
          { timeout: 15_000 },
        )
        .toBe(true);
    },
    async undoRevoke() {
      const undo = page.locator(".toast-region .toast button", { hasText: t("settings.sites.undo") });
      await expect(undo).toBeVisible({ timeout: 5_000 });
      await undo.click();
    },
    async markedSite() {
      await waitReady();
      return page.evaluate(() => ({
        site: document.querySelector("li.site[aria-current=true]")?.getAttribute("data-site") ?? null,
        note: (document.querySelector("[data-section-body=sites] .note.info[role=status]") as HTMLElement | null)?.innerText ?? null,
      }));
    },
    async pairedAgents() {
      await ensure("sites");
      return page.evaluate(() =>
        [...document.querySelectorAll("li[data-paired]")].map((row) => ({
          agentId: row.getAttribute("data-paired") ?? "",
          name: (row.querySelector("strong")?.textContent ?? "").trim(),
        })),
      );
    },
    async unpair(name) {
      await ensure("sites");
      const rows = page.locator("li[data-paired]");
      await expect(rows.first(), "the settings page lists no paired outside agent").toBeVisible({ timeout: 15_000 });
      const row = name === undefined ? rows.first() : rows.filter({ has: page.locator("strong", { hasText: name }) }).first();
      const agentId = await row.getAttribute("data-paired");
      await row.locator("button").click();
      await expect(page.locator(`li[data-paired=${JSON.stringify(agentId)}]`)).toHaveCount(0, { timeout: 15_000 });
    },
    async uploadRoots() {
      await ensure("sites");
      return page.evaluate(() => [...document.querySelectorAll("li[data-upload-root]")].map((row) => row.getAttribute("data-upload-root") ?? ""));
    },
    async removeUploadRoot(root) {
      await ensure("sites");
      const row = page.locator(`li[data-upload-root=${JSON.stringify(root)}]`);
      await expect(row, `the settings page lists no upload folder ${root}`).toBeVisible({ timeout: 20_000 });
      await row.locator("button").click();
      await expect(row).toHaveCount(0, { timeout: 15_000 });
    },
    async transitions() {
      await ensure("sites");
      return page.evaluate(() => [...document.querySelectorAll("li[data-transition]")].map((row) => row.getAttribute("data-transition") ?? ""));
    },
    async forgetTransition(from, to) {
      await ensure("sites");
      const row = page.locator(`li[data-transition=${JSON.stringify(`${from}→${to}`)}]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.locator("button").click();
      await expect(row).toHaveCount(0, { timeout: 15_000 });
    },

    async consent() {
      await ensure("tools");
      return page.evaluate(() => document.querySelector("[data-section-body=tools]")?.getAttribute("data-consent") ?? null);
    },
    async setBrowserTools(on) {
      await ensure("tools");
      const toggle = page
        .locator(`[data-section-body=tools] button[role=switch][aria-label=${JSON.stringify(t("settings.tools.switchTitle"))}]`)
        .first();
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
      await expect
        .poll(() => page.evaluate(() => document.querySelector("[data-section-body=tools]")?.getAttribute("data-consent") ?? null), {
          timeout: 15_000,
        })
        .toBe(on ? "granted" : "withdrawn");
    },

    async summary() {
      await waitReady();
      return page.evaluate(() => (document.querySelector("nav.side .side-sum strong")?.textContent ?? "").trim());
    },
    async agentCards() {
      await ensure("agents");
      return cards();
    },
    async setCardOpen(agent, open) {
      await ensure("agents");
      const disc = card(agent).locator("button.disc");
      if ((await disc.getAttribute("aria-expanded")) !== String(open)) await disc.click();
      await expect(disc).toHaveAttribute("aria-expanded", String(open));
    },
    async setAgentEnabled(agent, on) {
      await ensure("agents");
      const toggle = card(agent).locator(".acard-ctl button[role=switch]");
      if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
      await expect(card(agent)).toHaveAttribute("data-enabled", String(on), { timeout: 15_000 });
    },
    async makeDefault(agent) {
      await ensure("agents");
      await card(agent).locator("button.mkdef").click();
      await expect.poll(async () => (await cards()).find((entry) => entry.agent === agent)?.isDefault ?? false, { timeout: 15_000 }).toBe(true);
    },
    async pressTest(agent) {
      await ensure("agents");
      const button = card(agent).locator(".test-ask button");
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
    },
    async testLine(agent) {
      return page.evaluate((id: string) => {
        const line = document.querySelector(`article.acard[data-agent=${JSON.stringify(id)}] .test-line`) as HTMLElement | null;
        return line === null ? null : { outcome: line.getAttribute("data-test-outcome"), text: line.innerText };
      }, agent);
    },
    async cardText(agent) {
      await ensure("agents");
      return page.evaluate(
        (id: string) => (document.querySelector(`article.acard[data-agent=${JSON.stringify(id)}]`) as HTMLElement | null)?.innerText ?? "",
        agent,
      );
    },
    async pressDownload(agent) {
      await ensure("agents");
      // Download is in the open card only. A card opens by itself from the state it first shows (FR-377):
      // one first shown in another state and needing a download only later stays shut, so open it as the
      // owner would (#20: in one of three runs Codex read Needs a download with its card shut).
      const disc = card(agent).locator("button.disc");
      if ((await disc.getAttribute("aria-expanded")) !== "true") await disc.click();
      await expect(disc).toHaveAttribute("aria-expanded", "true");
      const button = page.locator(`[data-fid=${JSON.stringify(`download-${agent}`)}]`);
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
    },
    async downloadLabel(agent) {
      await ensure("agents");
      return page.evaluate(
        (fid: string) => (document.querySelector(`[data-fid=${JSON.stringify(fid)}]`) as HTMLElement | null)?.innerText.trim() ?? null,
        `download-${agent}`,
      );
    },
    async pressCancel(agent) {
      await ensure("agents");
      // Cancel is in the open card only. A card that is already downloading when the page opens starts
      // collapsed (FR-377 opens the ones needing a download or with warnings), so open it as the owner would.
      const disc = card(agent).locator("button.disc");
      if ((await disc.getAttribute("aria-expanded")) !== "true") await disc.click();
      await expect(disc).toHaveAttribute("aria-expanded", "true");
      const button = page.locator(`[data-fid=${JSON.stringify(`cancel-${agent}`)}]`);
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
    },
    async downloadPercent(agent) {
      return page.evaluate((id: string) => {
        const bar = document.querySelector(`article.acard[data-agent=${JSON.stringify(id)}] [role=progressbar]`);
        const now = bar?.getAttribute("aria-valuenow");
        return now === null || now === undefined || now === "" ? null : Number(now);
      }, agent);
    },
    async recordNotices() {
      await page.evaluate(() => {
        const target = window as unknown as { __hallpassNotices?: string[] };
        if (target.__hallpassNotices !== undefined) return;
        const seen: string[] = [];
        target.__hallpassNotices = seen;
        // The page keeps one toast element and changes its words for the next notice: a new element, or
        // new words in one, is a new notice. (The same words again while the first is still up change
        // nothing on screen, so they cannot be told apart here.)
        const lastWords = new WeakMap<Element, string>();
        const look = (): void => {
          for (const toast of document.querySelectorAll(".toast-region .toast")) {
            const words = (toast.querySelector("span") as HTMLElement | null)?.textContent ?? "";
            if (lastWords.get(toast) === words) continue;
            lastWords.set(toast, words);
            seen.push(words);
          }
        };
        look();
        new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    },
    async notices() {
      return page.evaluate(() => [...((window as unknown as { __hallpassNotices?: string[] }).__hallpassNotices ?? [])]);
    },

    async browserName() {
      await ensure("connection");
      return page.evaluate(() => (document.querySelector("form.rename input[type=text]") as HTMLInputElement | null)?.value ?? null);
    },
    async renameBrowser(name) {
      await ensure("connection");
      const input = page.locator("form.rename input[type=text]");
      await input.fill(name);
      await page.locator("form.rename button[type=submit]").click();
      await expect.poll(notice, { timeout: 15_000 }).toBe(t("settings.connection.renamed", { name }));
    },
    recordCopies,
    copies,
    async copyDetails() {
      await ensure("connection");
      return nextCopy(() => page.locator("button", { hasText: t("settings.connection.copy") }).click());
    },
    async showOutput(agent, timeoutMs = 20_000) {
      await ensure("connection");
      const block = page.locator(`section.diag[data-diag=${JSON.stringify(agent)}]`);
      const toggle = block.locator("button[aria-expanded]");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect
        .poll(() => block.evaluate((element) => element.querySelector("pre, p.diag-wait:not([role=status])") !== null), { timeout: timeoutMs })
        .toBe(true);
      return block.evaluate((element) => (element.querySelector("pre") as HTMLElement | null)?.innerText ?? "");
    },
    async copyOutput(agent) {
      await ensure("connection");
      const block = page.locator(`section.diag[data-diag=${JSON.stringify(agent)}]`);
      return nextCopy(() => block.locator("button", { hasText: t("settings.diag.copy") }).click());
    },

    async setAppearance(change) {
      await waitReady();
      if (change.theme !== undefined) await page.selectOption("#settings-theme", change.theme);
      if (change.language !== undefined) await page.selectOption("#settings-language", change.language);
      if (change.language !== undefined && change.language !== "system") {
        await expect.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 10_000 }).toBe(change.language);
      }
      if (change.theme !== undefined) {
        const theme = change.theme;
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")), { timeout: 10_000 })
          .toBe(theme === "system" ? null : theme);
      }
    },

    async screenshot(path, fullPage = true) {
      await page.screenshot({ path, fullPage });
    },
    async close() {
      await page.close().catch(() => undefined);
    },
  };
}
