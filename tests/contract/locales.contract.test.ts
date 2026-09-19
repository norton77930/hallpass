import { describe, expect, it } from "vitest";

describe("T013 locales contract", () => {
  it("keeps en-US and zh-TW keys and placeholders identical", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const en = await import("../../apps/extension/src/locales/en-US.js");
    const zh = await import("../../apps/extension/src/locales/zh-TW.js");
    const enKeys = Object.keys(en.messages).sort();
    const zhKeys = Object.keys(zh.messages).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(zhKeys).toEqual(enKeys);
    for (const key of enKeys) {
      const enText = (en.messages as Record<string, string>)[key] ?? "";
      const zhText = (zh.messages as Record<string, string>)[key] ?? "";
      const enPlaceholders = [...enText.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]);
      const zhPlaceholders = [...zhText.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]);
      expect(zhPlaceholders, key).toEqual(enPlaceholders);
    }
    expect(catalog.FALLBACK_LOCALE).toBe("en-US");
  });

  it("selects zh-TW only for exact zh-TW and otherwise en-US", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    expect(catalog.selectLocale("zh-TW")).toBe("zh-TW");
    expect(catalog.selectLocale("zh-CN")).toBe("en-US");
    expect(catalog.selectLocale("en-GB")).toBe("en-US");
    expect(catalog.selectLocale("zh")).toBe("en-US");
  });

  it("falls back to reviewed English and never returns a message key", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const text = catalog.lookup("workspace.title", "xx-XX");
    expect(text).not.toBe("workspace.title");
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders remote text as inert plain text", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const hostile = "<script>alert(1)</script> [click](javascript:alert(1))";
    const rendered = catalog.renderInertText(hostile);
    expect(rendered).toBe(hostile);
    expect(catalog.inertRenderMode).toBe("text");
  });

  it("WP2 gives each consent scope its own allow label in both locales", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const scopeKeys = ["consent.allowPageRead", "consent.allowFormValues", "consent.allowAction"];
    for (const locale of ["en-US", "zh-TW"]) {
      const labels = scopeKeys.map((key) => catalog.lookup(key, locale));
      for (const label of labels) {
        expect(label.length, locale).toBeGreaterThan(0);
      }
      // A single "Allow" cannot tell a page read, a form-value disclosure, and one browser effect
      // apart, so each scope carries its own reviewed wording.
      expect(new Set(labels).size, locale).toBe(scopeKeys.length);
    }
    const en = await import("../../apps/extension/src/locales/en-US.js");
    expect(Object.keys(en.messages)).not.toContain("consent.allow");
  });

  it("WP2 resolves the review target, risk, and lifetime copy in both locales", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const contracts = await import("@hallpass/contracts");
    const riskKeys: Record<string, string> = {
      "view-only": "risk.viewOnly",
      activation: "risk.activation",
      "text-entry": "risk.textEntry",
      unclassified: "risk.unclassified",
    };
    const roleKeys: Record<string, string> = {
      button: "role.button",
      textbox: "role.textbox",
      combobox: "role.combobox",
      control: "role.control",
      document: "role.document",
    };
    for (const locale of ["en-US", "zh-TW"]) {
      for (const risk of contracts.ACTION_RISKS) {
        expect(catalog.lookup(riskKeys[risk] ?? "", locale), `${risk} ${locale}`).not.toBe(
          catalog.lookup("workspace.title", locale),
        );
      }
      for (const role of contracts.TARGET_ROLES) {
        expect(catalog.lookup(roleKeys[role] ?? "", locale), `${role} ${locale}`).not.toBe(
          catalog.lookup("workspace.title", locale),
        );
      }
      for (const lifetime of contracts.GRANT_LIFETIMES) {
        const key = {
          "current-task": "lifetime.currentTask",
          "current-task-current-document": "lifetime.currentDocument",
          "one-dispatch": "lifetime.oneDispatch",
        }[lifetime];
        expect(catalog.lookup(key, locale), `${lifetime} ${locale}`).not.toBe(
          catalog.lookup("workspace.title", locale),
        );
      }
    }
  });

  it("002 pins every run reason, wait condition, action, and resolution string in both locales", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const en = await import("../../apps/extension/src/locales/en-US.js");
    const zh = await import("../../apps/extension/src/locales/zh-TW.js");
    const contracts = await import("@hallpass/contracts");
    // The panel names a step by its capability (`side-panel/human-labels.ts`), so the key list is
    // derived from the closed capability set rather than copied: an action added to the contract
    // without reviewed copy leaves no key here to look up, and this test says so.
    const actionKeys: Record<string, string> = {
      "browser.scroll": "action.scroll",
      "browser.click": "action.click",
      "browser.enter-text": "action.enterText",
      "browser.key-press": "action.keyPress",
      "browser.hover": "action.hover",
      "browser.double-click": "action.doubleClick",
      "browser.drag": "action.drag",
    };
    const keys = [
      // `completed` is the one stop reason the panel never names as a reason: it says how many
      // steps ran instead, in the kept-step wording when the user excluded any.
      ...contracts.RUN_STOP_REASONS.filter((reason) => reason !== "completed").map(
        (reason) => `run.reason.${reason}`,
      ),
      "run.completed",
      "run.completedKept",
      "run.stopped",
      // What the context strip says the last description resolved to.
      "resolution.resolved",
      "resolution.candidates",
      "resolution.noMatch",
      "resolution.tooBroad",
      ...contracts.WAIT_CONDITIONS.map((condition) => `wait.condition.${condition}`),
      "wait.bound",
      ...contracts.BRIDGE_ACTIONS.map((action) => actionKeys[action] ?? action),
      // A wait is not an action, but the plan card still names the step.
      "action.wait",
      // The second endpoint of a drag, which only a drag's review names.
      "argument.dropTarget",
    ];
    for (const key of keys) {
      for (const [locale, messages] of [
        ["en-US", en.messages],
        ["zh-TW", zh.messages],
      ] as const) {
        const text = (messages as Record<string, string>)[key];
        expect(text, `${key} ${locale}`).toBeTruthy();
        expect(text, `${key} ${locale}`).not.toBe(key);
        // A key the catalogue does not have resolves to the generic workspace title, which would
        // otherwise read on the card as reviewed copy for the thing that actually happened.
        expect(catalog.lookup(key, locale), `${key} ${locale}`).toBe(text);
      }
    }
  });

  /**
   * 003/T068 — every sentence the Agent section can show, in both locales.
   *
   * The panel's keys are exported as a list (`side-panel/agent-panel-keys.ts`) rather than counted
   * here, because two of the three groups are expansions of closed contract sets: a mode or a tool
   * added to the contract arrives in the list without anybody remembering, and this test then asks
   * for its copy in both languages on the same day.
   *
   * The list is checked against the panel's own source as well. An exported list that the component
   * had drifted from would pass while the owner read an unresolved key, so the file is scanned for
   * the keys it looks up literally, and each one has to be in the list.
   */
  it("003 gives every agent panel key reviewed copy in both locales", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const keys = await import("../../apps/extension/src/side-panel/agent-panel-keys.js");
    const contracts = await import("@hallpass/contracts");
    const en = await import("../../apps/extension/src/locales/en-US.js");
    const zh = await import("../../apps/extension/src/locales/zh-TW.js");

    expect(keys.AGENT_PANEL_KEYS.length).toBeGreaterThan(0);
    // Every tool the agent may call can be the subject of a question the owner answers, so every
    // one of them needs a sentence - not only the ones that raise a prompt today.
    for (const tool of contracts.AGENT_TOOL_NAMES) {
      expect(keys.AGENT_PANEL_KEYS, tool).toContain(`agent.summary.${tool}`);
    }
    for (const mode of contracts.SITE_MODES) {
      expect(keys.AGENT_PANEL_KEYS, mode).toContain(keys.MODE_KEYS[mode]);
    }

    for (const key of keys.AGENT_PANEL_KEYS) {
      for (const [locale, messages] of [
        ["en-US", en.messages],
        ["zh-TW", zh.messages],
      ] as const) {
        const text = (messages as Record<string, string>)[key];
        expect(text, `${key} ${locale}`).toBeTruthy();
        // A key the catalogue does not have resolves to the generic workspace title, which would
        // read on the panel as reviewed copy for the decision the owner is making.
        expect(catalog.lookup(key, locale), `${key} ${locale}`).toBe(text);
      }
    }

    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // 006 S1: the panel is the `agent/` folder, one component per composition; every one is scanned.
    const folder = fileURLToPath(new URL("../../apps/extension/src/side-panel/agent/", import.meta.url));
    const files = (await readdir(folder)).filter((name) => name.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(0);
    const source = (await Promise.all(files.map((name) => readFile(`${folder}${name}`, "utf8")))).join("\n");
    // Both spellings the components use: `lookup("agent.x", …)` and the local `t("agent.x")`.
    const looked = [...source.matchAll(/\b(?:lookup|t)\("(agent\.[a-zA-Z0-9._]+)"/gu)].map((match) => match[1] ?? "");
    expect(looked.length).toBeGreaterThan(0);
    for (const key of looked) {
      expect(keys.AGENT_PANEL_KEYS, `${key} is looked up by the panel but not listed`).toContain(key);
    }
  });

  it("fails closed when safety or consent copy cannot be resolved", async () => {
    const catalog = await import("../../apps/extension/src/locales/catalog.js");
    const result = catalog.lookupSafety("missing.safety.key", "zh-TW");
    expect(result.ok).toBe(false);
  });
});
