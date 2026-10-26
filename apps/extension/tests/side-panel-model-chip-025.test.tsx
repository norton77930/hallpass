import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPanelCommandSchema,
  type ConversationAgentAvailability,
  type ConversationModelOffer,
  type ConversationPanelState,
  type ConversationView,
} from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  commandsSent,
  emitEvent,
  lastCommandId,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 025 S3 (T808, T813, T818, T820) - the model chip and its popup: FR-398 - FR-405, R-407.
 *
 * What the panel shows comes from the worker's projection (the agent's remembered offer and choice
 * before a conversation starts, the open conversation's `models` while it runs, its `model` once it
 * stopped) and from the `model` event; what leaves is `ui.conversation.start` with the choice or one
 * `ui.conversation.set-model`. Invented names with the shapes the four agents report (research R-398).
 */

const CLAUDE_OFFER: ConversationModelOffer = {
  source: "config",
  configIds: { model: "model", effort: "effort" },
  models: [
    { value: "default", name: "Default (recommended)", description: "Model Alpha" },
    { value: "model-beta", name: "Model Beta" },
    { value: "model-gamma", name: "Model Gamma" },
  ],
  efforts: [
    { value: "default", name: "Default" },
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
  defaultModel: "default",
  defaultEffort: "default",
};
const CODEX_OFFER: ConversationModelOffer = {
  source: "config",
  configIds: { model: "model", effort: "effort" },
  models: [
    { value: "z-max", name: "zenith-max" },
    { value: "z-mini", name: "zenith-mini" },
  ],
  efforts: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};
const LONG = "Acme · model-gamma-with-a-very-long-provider-suffix-that-cannot-fit-in-the-popup";
const HERMES_OFFER: ConversationModelOffer = {
  source: "models",
  models: [
    { value: "acme:beta", name: "Acme · model-beta" },
    { value: "acme:long", name: LONG },
  ],
  efforts: [],
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const claude = (extra: Partial<ConversationAgentAvailability> = {}): ConversationAgentAvailability => ({
  agent: "claude-code",
  availability: "ready",
  version: "2.1.0",
  ...extra,
});
const codex = (extra: Partial<ConversationAgentAvailability> = {}): ConversationAgentAvailability => ({
  agent: "codex",
  availability: "ready",
  version: "0.50.0",
  ...extra,
});
const READY = (...agents: ConversationAgentAvailability[]): ConversationPanelState => ({ ...CONVERSATION_READY, agents });
const OPEN = (view: Partial<ConversationView>, ...agents: ConversationAgentAvailability[]): ConversationPanelState => ({
  ...CONVERSATION_OPEN,
  agents: agents.length === 0 ? CONVERSATION_OPEN.agents : agents,
  conversations: [{ ...VIEW, ...view }],
});

const modelChip = () => document.querySelector<HTMLButtonElement>("[data-chip='model']");
const chipKinds = () => [...document.querySelectorAll("[data-chip]")].map((chip) => chip.getAttribute("data-chip"));
const chipWords = () => modelChip()?.textContent?.replace(/\s+/g, " ").trim();
const modelRadios = () => within(screen.getByRole("radiogroup", { name: ui("conversation.model.label") })).getAllByRole("radio");
const effortRadios = () => within(screen.getByRole("radiogroup", { name: ui("conversation.model.effortLabel") })).getAllByRole("radio");
const radioNames = (radios: HTMLElement[]) => radios.map((radio) => radio.getAttribute("data-value"));
const checked = (radios: HTMLElement[]) => radios.filter((radio) => radio.getAttribute("aria-checked") === "true").map((radio) => radio.getAttribute("data-value"));
const log = () => screen.getByRole("log");
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};
const composeAndSend = (words = "hello") => {
  fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: words } });
  fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
};

describe("025 the model chip and its popup", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  describe("T808 before the conversation starts", () => {
    it("sits after the mode chip, reads the remembered model, and adds the effort only when it is not the default", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      expect(chipKinds()).toEqual(["agent", "folder", "mode", "model"]);
      expect(chipWords()).toBe("Model Beta · High");
      expect(modelChip()?.getAttribute("aria-label")).toBe(ui("conversation.chip.model").replace("{model}", "Model Beta · High"));
      cleanup();

      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "default" } } })));
      expect(chipWords()).toBe("Model Beta");
      cleanup();

      // The agent's own default is said in the panel's words.
      await open(READY(claude({ models: { offer: CLAUDE_OFFER } })));
      expect(chipWords()).toBe(ui("conversation.model.default"));
    });

    it("says Default and that the list comes with the conversation when nothing is remembered (FR-400)", async () => {
      await open(READY(claude()));

      expect(chipWords()).toBe(ui("conversation.model.default"));
      fireEvent.click(modelChip()!);
      const radios = modelRadios();
      expect(radioNames(radios)).toEqual(["default"]);
      expect(checked(radios)).toEqual(["default"]);
      expect(screen.getByText(ui("conversation.model.noList"))).toBeTruthy();
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.effortLabel") })).toBeNull();
    });

    it("has no model chip for an agent known to report no models (US4)", async () => {
      await open(READY(claude({ models: { offer: { source: "models", models: [], efforts: [] } } })));

      expect(modelChip()).toBeNull();
      expect(chipKinds()).toEqual(["agent", "folder", "mode"]);
    });

    it("lists the models (the agent's default first, the current one checked), a divider and the efforts", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      const popup = document.getElementById(modelChip()!.getAttribute("aria-controls")!)!;
      expect(modelChip()?.getAttribute("aria-expanded")).toBe("true");
      expect(radioNames(modelRadios())).toEqual(["default", "model-beta", "model-gamma"]);
      expect(checked(modelRadios())).toEqual(["model-beta"]);
      expect(radioNames(effortRadios())).toEqual(["default", "low", "high"]);
      expect(checked(effortRadios())).toEqual(["high"]);
      expect(popup.querySelector("[data-model-divider]")).not.toBeNull();
      // The agent's own words: its name and, under it, its description.
      expect(modelRadios()[0]?.textContent).toContain("Default (recommended)");
      expect(modelRadios()[0]?.textContent).toContain("Model Alpha");
      // The checked one has the focus, so the arrows start where the owner is.
      expect(document.activeElement).toBe(modelRadios()[1]);
    });

    it("offers no efforts and no divider for an agent that has none (Hermes)", async () => {
      await open(READY(claude({ models: { offer: HERMES_OFFER, choice: { model: "acme:beta" } } })));

      expect(chipWords()).toBe("Acme · model-beta");
      fireEvent.click(modelChip()!);
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.effortLabel") })).toBeNull();
      expect(document.querySelector("[data-model-divider]")).toBeNull();
    });

    it("keeps a long name whole for the pointer and the screen reader", async () => {
      await open(READY(claude({ models: { offer: HERMES_OFFER, choice: { model: "acme:long" } } })));

      fireEvent.click(modelChip()!);
      const long = modelRadios().find((radio) => radio.getAttribute("data-value") === "acme:long")!;
      expect(long.getAttribute("title")).toBe(LONG);
      expect(long.getAttribute("aria-label")).toBe(LONG);
      expect(modelChip()?.getAttribute("title")).toContain(LONG);
    });

    it("keeps the popup open when a model or an effort is chosen, and moves the chip", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[2]!);
      expect(modelChip()?.getAttribute("aria-expanded")).toBe("true");
      expect(checked(modelRadios())).toEqual(["model-gamma"]);
      fireEvent.click(effortRadios()[1]!);
      expect(modelChip()?.getAttribute("aria-expanded")).toBe("true");
      expect(checked(effortRadios())).toEqual(["low"]);
      expect(chipWords()).toBe("Model Gamma · Low");
      // Nothing leaves the panel before the owner sends.
      expect(commandsSent(port)).toEqual([]);
    });

    it("moves with the arrows, closes on Escape with the focus back on the chip, and on a press outside", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      fireEvent.keyDown(modelRadios()[1]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(modelRadios()[2]);
      fireEvent.keyDown(modelRadios()[2]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(modelRadios()[0]);
      // An arrow only moves; the choice is Enter or Space (a press), so a pass over the list asks nothing.
      expect(checked(modelRadios())).toEqual(["model-beta"]);

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
      expect(document.activeElement).toBe(modelChip());

      fireEvent.click(modelChip()!);
      fireEvent.pointerDown(document.querySelector(".agent-conversation-composer textarea")!);
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
    });

    it("closes when the focus goes on to something outside it (Tab), but not for its own chip's press", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      // The chip's own press: the focus goes to the chip first and its click toggles - it must not reopen.
      fireEvent.blur(modelRadios()[1]!, { relatedTarget: modelChip() });
      expect(screen.getByRole("radiogroup", { name: ui("conversation.model.label") })).toBeTruthy();
      fireEvent.blur(modelRadios()[1]!, { relatedTarget: modelRadios()[2] });
      expect(screen.getByRole("radiogroup", { name: ui("conversation.model.label") })).toBeTruthy();

      fireEvent.blur(modelRadios()[1]!, { relatedTarget: document.querySelector(".agent-conversation-composer textarea") });
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
      expect(modelChip()?.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes the mode menu when it opens, and the other way round", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER } })));

      fireEvent.click(modelChip()!);
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) }));
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
      fireEvent.click(modelChip()!);
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.mode.label") })).toBeNull();
    });

    it("sends the choice with the start, and nothing extra when the owner chose nothing", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[2]!);
      fireEvent.click(effortRadios()[1]!);
      composeAndSend();

      expect(commandsSent(port)).toEqual([
        {
          type: "ui.conversation.start",
          payload: { agent: "claude-code", folder: { kind: "scratch" }, model: { model: "model-gamma", effort: "low" } },
        },
      ]);
      expectValidCommands(port);
      cleanup();
      port.sent.length = 0;

      // The remembered choice is only shown; the broker applies it itself (FR-401).
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));
      composeAndSend();
      expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } }]);
    });

    it("sends the model alone, with the remembered effort, when only the model was chosen", async () => {
      await open(READY(claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } })));

      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[2]!);
      composeAndSend();

      expect(commandsSent(port)).toEqual([
        { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" }, model: { model: "model-gamma", effort: "high" } } },
      ]);
    });

    it("sends the effort alone when only an effort was chosen and no model is known (no default, nothing remembered)", async () => {
      await open(READY(claude(), codex({ models: { offer: CODEX_OFFER } })));
      fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
      fireEvent.click(within(screen.getByRole("menu", { name: ui("conversation.agentMenu.label") })).getByRole("menuitemradio", { name: /^Codex/ }));

      fireEvent.click(modelChip()!);
      fireEvent.click(effortRadios()[1]!);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      composeAndSend();

      expect(commandsSent(port)).toEqual([
        { type: "ui.conversation.start", payload: { agent: "codex", folder: { kind: "scratch" }, model: { effort: "high" } } },
      ]);
      expectValidCommands(port);
    });
  });

  describe("T820 the chip follows the agent chip", () => {
    it("shows each agent's own offer and choice, and no chip for an agent with an empty offer", async () => {
      await open(
        READY(
          claude({ models: { offer: CLAUDE_OFFER, choice: { model: "model-beta", effort: "high" } } }),
          codex({ models: { offer: CODEX_OFFER, choice: { model: "z-mini", effort: "low" } } }),
        ),
      );
      expect(chipWords()).toBe("Model Beta · High");

      fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
      fireEvent.click(within(screen.getByRole("menu", { name: ui("conversation.agentMenu.label") })).getByRole("menuitemradio", { name: /^Codex/ }));
      expect(chipWords()).toBe("zenith-mini · Low");
      fireEvent.click(modelChip()!);
      expect(radioNames(modelRadios())).toEqual(["z-max", "z-mini"]);
      expect(checked(modelRadios())).toEqual(["z-mini"]);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });

      // A pick made for one agent is kept for it while the other is on the chip.
      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[0]!);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
      fireEvent.click(within(screen.getByRole("menu", { name: ui("conversation.agentMenu.label") })).getByRole("menuitemradio", { name: /^Claude Code/ }));
      expect(chipWords()).toBe("Model Beta · High");
      fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
      fireEvent.click(within(screen.getByRole("menu", { name: ui("conversation.agentMenu.label") })).getByRole("menuitemradio", { name: /^Codex/ }));
      expect(chipWords()).toBe("zenith-max · Low");
    });

    it("has no chip once the agent on the chip reports none", async () => {
      await open(
        READY(
          claude({ models: { offer: CLAUDE_OFFER } }),
          codex({ models: { offer: { source: "models", models: [], efforts: [] } } }),
        ),
      );
      expect(modelChip()).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
      fireEvent.click(within(screen.getByRole("menu", { name: ui("conversation.agentMenu.label") })).getByRole("menuitemradio", { name: /^Codex/ }));
      expect(modelChip()).toBeNull();
    });
  });

  describe("T813 a running conversation", () => {
    const running = (extra: Partial<ConversationView> = {}) =>
      OPEN(
        { models: { ...CODEX_OFFER, current: { model: "z-max", effort: "high" } }, agent: "codex", ...extra },
        claude(),
        codex({ models: { offer: CODEX_OFFER, choice: { model: "z-max", effort: "high" } } }),
      );

    it("shows what the agent reports, and sends one set-model per choice with the popup left open", async () => {
      await open(running());

      expect(chipWords()).toBe("zenith-max · High");
      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[1]!);
      fireEvent.click(effortRadios()[0]!);

      expect(modelChip()?.getAttribute("aria-expanded")).toBe("true");
      expect(commandsSent(port)).toEqual([
        { type: "ui.conversation.set-model", payload: { conversationId: CONVERSATION_ID, model: "z-mini" } },
        { type: "ui.conversation.set-model", payload: { conversationId: CONVERSATION_ID, effort: "low" } },
      ]);
      expectValidCommands(port);
    });

    it("sends nothing for the value that is already the current one", async () => {
      await open(running());

      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[0]!);
      fireEvent.click(effortRadios()[1]!);
      expect(commandsSent(port)).toEqual([]);
    });

    it("follows the model the agent now reports (the broker's view, not the press)", async () => {
      await open(running());
      project(port, withConversation(running({ models: { ...CODEX_OFFER, current: { model: "z-mini", effort: "high" } } })));

      expect(chipWords()).toBe("zenith-mini · High");
    });

    it.each(["running", "waiting-for-owner"] as const)(
      "is shown but not open while the conversation is %s, and says when it can be changed (FR-403)",
      async (state) => {
        await open(running({ state }));

        const chip = modelChip()!;
        expect(chip.getAttribute("aria-disabled")).toBe("true");
        // Focusable for the keyboard and a screen reader: not the `disabled` attribute.
        expect(chip.hasAttribute("disabled")).toBe(false);
        const said = document.getElementById(chip.getAttribute("aria-describedby")!);
        expect(said?.textContent).toBe(ui("conversation.model.busy"));
        fireEvent.click(chip);
        expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
        chip.focus();
        expect(document.activeElement).toBe(chip);
      },
    );

    it("is available again once the answer is finished", async () => {
      await open(running({ state: "running" }));
      expect(modelChip()?.getAttribute("aria-disabled")).toBe("true");

      emitEvent(port, 1, { type: "state", state: "idle" });
      expect(modelChip()?.getAttribute("aria-disabled")).toBeNull();
      expect(screen.queryByText(ui("conversation.model.busy"))).toBeNull();
      fireEvent.click(modelChip()!);
      expect(screen.getByRole("radiogroup", { name: ui("conversation.model.label") })).toBeTruthy();
    });

    it("is shown but not open while a permission card waits", async () => {
      await open(running());
      emitEvent(port, 1, {
        type: "permission",
        requestId: "req-1",
        toolCallId: "tool-1",
        kind: "edit",
        title: "Edit a.txt",
        detail: "",
      });

      expect(modelChip()?.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText(ui("conversation.model.busy"))).toBeTruthy();
    });

    it("draws one line for an accepted change, naming the effort too when the model moved it", async () => {
      await open(running());

      emitEvent(port, 1, { type: "model", model: "zenith-mini" });
      emitEvent(port, 2, { type: "model", model: "zenith-mini", effort: "Low" });
      emitEvent(port, 3, { type: "model", model: "zenith-max", effort: "High", effortChanged: true });

      const lines = [...log().querySelectorAll("[data-model-line]")].map((line) => line.textContent);
      expect(lines).toEqual([
        ui("conversation.model.changed").replace("{model}", "zenith-mini"),
        ui("conversation.model.effortChanged").replace("{effort}", "Low"),
        ui("conversation.model.changedEffort").replace("{model}", "zenith-max").replace("{effort}", "High"),
      ]);
    });

    it("says the change line in zh-TW too", async () => {
      await open(running(), "zh-TW");

      emitEvent(port, 1, { type: "model", model: "zenith-mini" });
      const line = log().querySelector("[data-model-line]");
      expect(line?.textContent).toBe(lookup("conversation.model.changed", "zh-TW").replace("{model}", "zenith-mini"));
      expect(line?.textContent).not.toBe(lookup("conversation.model.changed", "en-US").replace("{model}", "zenith-mini"));
    });

    it("says a refused change in the panel's words with the agent's own text, once (no second error card)", async () => {
      await open(running());

      emitEvent(port, 1, {
        type: "notice",
        code: "model-refused",
        text: "Codex kept zenith-max: it refused zenith-mini (The requested model is not available right now.).",
      });

      const notice = log().querySelector("[data-notice-code='model-refused']");
      expect(notice?.textContent).toBe(
        ui("conversation.notice.model-refused.named")
          .replace("{agent}", "Codex")
          .replace("{asked}", "zenith-mini")
          .replace("{kept}", "zenith-max")
          .replace("{reason}", "The requested model is not available right now."),
      );

      // The command's own refusal carries the same fact; the log has it, so it is not said twice.
      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[1]!);
      act(() => {
        port.emit({
          type: "conversation-result",
          payload: {
            commandId: lastCommandId(port),
            ok: false,
            error: { code: "model-refused", detail: "The requested model is not available right now." },
          },
        });
      });
      expect(document.querySelectorAll("[data-notice-code='model-refused']").length).toBe(1);
    });

    it("says a remembered model that is no longer offered in the panel's words, in zh-TW too", async () => {
      const text = "Codex no longer offers zenith-old; the conversation uses zenith-max instead.";
      await open(running());
      emitEvent(port, 1, { type: "notice", code: "model-unavailable", text });
      expect(log().querySelector("[data-notice-code='model-unavailable']")?.textContent).toBe(
        ui("conversation.notice.model-unavailable.named").replace("{agent}", "Codex").replace("{model}", "zenith-old"),
      );
      cleanup();

      await open(running(), "zh-TW");
      emitEvent(port, 1, { type: "notice", code: "model-unavailable", text });
      expect(log().querySelector("[data-notice-code='model-unavailable']")?.textContent).toBe(
        lookup("conversation.notice.model-unavailable.named", "zh-TW").replace("{agent}", "Codex").replace("{model}", "zenith-old"),
      );
    });

    it("says a change the agent did not answer within the bound in the panel's words, in zh-TW too", async () => {
      const text = "Codex did not answer within 30 s, so the model is unchanged: it keeps zenith-max and did not switch to zenith-mini.";
      const words = (locale: "en-US" | "zh-TW") =>
        lookup("conversation.notice.model-refused.timeout", locale)
          .replace("{agent}", "Codex")
          .replace("{seconds}", "30")
          .replace("{kept}", "zenith-max")
          .replace("{asked}", "zenith-mini");
      await open(running());
      emitEvent(port, 1, { type: "notice", code: "model-refused", text });
      expect(log().querySelector("[data-notice-code='model-refused']")?.textContent).toBe(words("en-US"));
      cleanup();

      await open(running(), "zh-TW");
      emitEvent(port, 1, { type: "notice", code: "model-refused", text });
      expect(log().querySelector("[data-notice-code='model-refused']")?.textContent).toBe(words("zh-TW"));
    });

    it("reads an agent's refusal whose reason sounds like the timeout as the agent's refusal", async () => {
      const reason = "gateway did not answer within 30 s, so the model is unchanged: it keeps zenith-max and did not switch to zenith-mini";
      await open(running());
      emitEvent(port, 1, { type: "notice", code: "model-refused", text: `Codex kept zenith-max: it refused zenith-mini (${reason}).` });
      expect(log().querySelector("[data-notice-code='model-refused']")?.textContent).toBe(
        ui("conversation.notice.model-refused.named")
          .replace("{agent}", "Codex")
          .replace("{asked}", "zenith-mini")
          .replace("{kept}", "zenith-max")
          .replace("{reason}", reason),
      );
    });

    it("says the command refusals the panel can get from the picker", async () => {
      await open(running());

      fireEvent.click(modelChip()!);
      fireEvent.click(modelRadios()[1]!);
      act(() => {
        port.emit({
          type: "conversation-result",
          payload: { commandId: lastCommandId(port), ok: false, error: { code: "model-unknown", detail: "That model is not offered." } },
        });
      });
      expect(screen.getByText(ui("conversation.error.model-unknown"))).toBeTruthy();
    });
  });

  describe("T818 a conversation that is not running", () => {
    it("shows the model the conversation was left on, by the agent's remembered names, and cannot be opened", async () => {
      await open(OPEN({ state: "stopped", model: { model: "model-beta", effort: "high" } }, claude({ models: { offer: CLAUDE_OFFER } })));

      expect(chipWords()).toBe("Model Beta · High");
      expect(modelChip()?.hasAttribute("disabled") || modelChip()?.getAttribute("aria-disabled") === "true").toBe(true);
      fireEvent.click(modelChip()!);
      expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
    });

    it("shows the value itself when the agent's remembered offer does not know it, and no chip when nothing is known", async () => {
      await open(OPEN({ state: "stopped", model: { model: "retired-model" } }, claude()));
      expect(chipWords()).toBe("retired-model");
      cleanup();

      await open(OPEN({ state: "stopped" }, claude({ models: { offer: CLAUDE_OFFER } })));
      expect(modelChip()).toBeNull();
    });
  });
});
