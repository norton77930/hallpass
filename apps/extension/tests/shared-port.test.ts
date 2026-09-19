import { describe, expect, it } from "vitest";
import { DEFAULT_WAIT_POLL_MS, isTrustedControlSender } from "../src/service-worker/shared-port.js";

/**
 * 009/T243 — the two values both ports share, tested where they now live.
 *
 * The sender check used to be covered only through the runtimes that call it (the archived control
 * port's authorization case, the agent panel port's rejection cases). Here it is exercised
 * directly, so the rule survives the control port's removal: this extension's own side panel
 * document, never a page and never another extension.
 */

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;

describe("isTrustedControlSender", () => {
  it("trusts this extension's own side-panel document", () => {
    expect(isTrustedControlSender({ id: EXTENSION_ID, url: PANEL_URL }, EXTENSION_ID, PANEL_URL)).toBe(
      true,
    );
  });

  it("refuses another extension, a tab, another page of this extension, and no sender at all", () => {
    expect(
      isTrustedControlSender(
        { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", url: PANEL_URL },
        EXTENSION_ID,
        PANEL_URL,
      ),
    ).toBe(false);
    expect(
      isTrustedControlSender(
        { id: EXTENSION_ID, url: PANEL_URL, tab: { id: 3 } as chrome.tabs.Tab },
        EXTENSION_ID,
        PANEL_URL,
      ),
    ).toBe(false);
    expect(
      isTrustedControlSender(
        { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/offscreen.html` },
        EXTENSION_ID,
        PANEL_URL,
      ),
    ).toBe(false);
    expect(isTrustedControlSender(undefined, EXTENSION_ID, PANEL_URL)).toBe(false);
  });
});

describe("DEFAULT_WAIT_POLL_MS", () => {
  it("samples a wait condition four times a second", () => {
    expect(DEFAULT_WAIT_POLL_MS).toBe(250);
  });
});
