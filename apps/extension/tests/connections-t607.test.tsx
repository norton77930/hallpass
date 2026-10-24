import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_PAIRED, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 020/T607 - the defect of the full shot review that still sits in the second tab: what it says when
 * the helper cannot be reached.
 *
 * 024 R-381: the tab is Sessions now. The rest of this file (one open menu among the site chips, the
 * upload folders' lines, a site's name without https://) went to the settings page with the controls
 * it was about. The status row's menu is now the only menu on the tab, so there is nothing left for
 * it to be exclusive with.
 */

describe("T607 the Sessions tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage("sessions");
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  describe("Q1 the helper cannot be reached", () => {
    const DOWN = { ...CONVERSATION_READY, available: false, reason: "broker-unavailable" as const, consent: "unknown" as const };

    it.each(["en-US", "zh-TW"] as const)("in %s says so, with what to do, instead of 'no agent is connected'", async (locale) => {
      installTabStorage("conversation");
      renderShell(locale);
      project(port, withConversation(DOWN, NOT_PAIRED));
      // The Conversation tab's button leads to the Sessions tab.
      fireEvent.click(await screen.findByRole("button", { name: lookup("conversation.error.goConnections", locale) }));

      expect(screen.getByRole("heading", { name: lookup("agent.helperDown.title", locale) })).toBeTruthy();
      expect(screen.getByText(lookup("agent.helperDown.body", locale))).toBeTruthy();
      expect(screen.queryByRole("heading", { name: lookup("agent.notPaired.title", locale) })).toBeNull();
      expect(screen.getByRole("button", { name: lookup("agent.retry", locale) })).toBeTruthy();
    });

    it("keeps the generic card for a browser whose helper is fine", async () => {
      renderShell();
      project(port, withConversation({ ...CONVERSATION_READY, consent: "unknown" }, NOT_PAIRED));
      expect(await screen.findByRole("heading", { name: ui("agent.notPaired.title") })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: ui("agent.helperDown.title") })).toBeNull();
    });
  });
});
