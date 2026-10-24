import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SETTINGS_PORT_NAME, settingsCommandSchema } from "@hallpass/contracts";
import { SettingsApp } from "../src/settings/SettingsApp.js";
import { NOW, ui } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/**
 * 024 S3: the connector (`SettingsApp`) - the one place that touches `chrome.*`. A fake port stands in
 * for the service worker: the tests push worker messages through it and read the commands back.
 */

type Listener = (message: unknown) => void;

function installChrome(options: { appearance?: unknown; language?: string } = {}) {
  let listeners: Listener[] = [];
  let disconnects: Array<() => void> = [];
  const changed: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
  const port = {
    sent: [] as Array<Record<string, unknown>>,
    connects: 0,
    names: [] as string[],
    emit(message: unknown) {
      act(() => {
        for (const listener of [...listeners]) listener(message);
      });
    },
    drop() {
      const dying = disconnects;
      listeners = [];
      disconnects = [];
      act(() => {
        for (const listener of dying) listener();
      });
    },
    reply(commandId: string, result: Record<string, unknown> = {}) {
      port.emit({ type: "worker.settings.result", payload: { commandId, ok: true, ...result } });
    },
    last(): Record<string, unknown> {
      const found = port.sent.at(-1);
      if (found === undefined) throw new Error("nothing was sent");
      return found;
    },
    changeStorage(value: unknown) {
      act(() => {
        for (const listener of changed) listener({ agentAppearance: { newValue: value } }, "local");
      });
    },
  };
  const handle = {
    name: AGENT_SETTINGS_PORT_NAME,
    postMessage: (message: Record<string, unknown>) => void port.sent.push(message),
    disconnect: () => undefined,
    onMessage: { addListener: (l: Listener) => void listeners.push(l), removeListener: () => undefined },
    onDisconnect: { addListener: (l: () => void) => void disconnects.push(l), removeListener: () => undefined },
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: (info: { name: string }) => {
        port.connects += 1;
        port.names.push(info.name);
        return handle;
      },
      lastError: undefined,
    },
    storage: {
      local: { get: async () => (options.appearance === undefined ? {} : { agentAppearance: options.appearance }) },
      onChanged: {
        addListener: (l: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void changed.push(l),
        removeListener: () => undefined,
      },
    },
    i18n: { getUILanguage: () => options.language ?? "en-US" },
  };
  return port;
}

const mount = async (): Promise<ReturnType<typeof render>> => {
  const view = render(<SettingsApp />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

const sentCommands = (port: ReturnType<typeof installChrome>) => port.sent.map((message) => settingsCommandSchema.parse(message));

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
  document.documentElement.removeAttribute("data-theme");
});

describe("the connector: the port and the first projection", () => {
  it("connects as the settings page, shows Loading until the first projection, then the page", async () => {
    const port = installChrome();
    await mount();
    expect(port.names).toEqual([AGENT_SETTINGS_PORT_NAME]);
    expect(screen.getByText(ui("settings.loading"))).toBeTruthy();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    expect(screen.queryByText(ui("settings.loading"))).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title"));
  });

  it("asks the helper to check every agent on connect, with a command id", async () => {
    const port = installChrome();
    await mount();
    const [first] = sentCommands(port);
    expect(first).toMatchObject({ type: "ui.conversation.check-agents", payload: {} });
    expect(first!.commandId.length).toBeGreaterThan(0);
  });

  it("keeps the last projection when a message does not parse", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    port.emit({ type: "worker.settings.state", payload: { nonsense: true } });
    port.emit({ type: "something-else" });
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByText("Claude Code", { selector: "button span" })).toBeTruthy();
  });
});

describe("the connector: commands and their results", () => {
  it("sends a command with a fresh id and gives the page the result with that id", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Codex" }) }));
    });
    const command = settingsCommandSchema.parse(port.last());
    expect(command).toMatchObject({ type: "ui.settings.choices-set", payload: { enabled: { codex: false } } });
    expect(sentCommands(port).map((item) => item.commandId)).toEqual([...new Set(sentCommands(port).map((item) => item.commandId))]);
    // The default moved: the result says so, to the page that asked.
    await act(async () => {
      port.reply(command.commandId, { defaultMovedTo: "hermes" });
      await Promise.resolve();
    });
    expect(screen.getByText(ui("settings.default.moved", { agent: "Hermes" }))).toBeTruthy();
  });

  it("tells a refusal in words", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Codex" }) }));
    });
    await act(async () => {
      port.emit({ type: "worker.settings.result", payload: { commandId: settingsCommandSchema.parse(port.last()).commandId, ok: false, error: { code: "no-such-agent" } } });
      await Promise.resolve();
    });
    expect(screen.getByText(ui("settings.error.generic"))).toBeTruthy();
  });

  it("gives up on a command the worker never answers", async () => {
    vi.useFakeTimers();
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Codex" }) }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByText(ui("settings.error.generic"))).toBeTruthy();
  });

  it("shows the worker's toast once to this page", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    port.emit({ type: "worker.settings.toast", payload: { kind: "install-done", agent: "codex" } });
    expect(screen.getByText(ui("settings.toast.downloadDone", { agent: "Codex" }))).toBeTruthy();
  });

  it("hands an agent's lines to the page when the worker sends them, and requests them only on press", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ui("settings.nav.connection")) }));
    expect(sentCommands(port).filter((command) => command.type === "ui.conversation.diagnostics")).toHaveLength(0);
    const block = document.querySelector("[data-diag='codex']") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: ui("settings.diag.show") }));
    });
    expect(sentCommands(port).at(-1)).toMatchObject({ type: "ui.conversation.diagnostics", payload: { agent: "codex" } });
    port.emit({
      type: "worker.settings.diagnostics",
      payload: { agent: "codex", readAt: new Date(2026, 9, 24, 12, 0, 5).toISOString(), lines: ["first <redacted>", "second"] },
    });
    expect(block.querySelector("pre")?.textContent).toBe("first <redacted>\nsecond");
  });
});

describe("the connector: reconnecting", () => {
  it("reconnects after the worker goes away, checks the agents again, and fails what was waiting", async () => {
    vi.useFakeTimers();
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Codex" }) }));
    });
    port.drop();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(ui("settings.error.generic"))).toBeTruthy();
    expect(port.connects).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(port.connects).toBe(2);
    expect(sentCommands(port).filter((command) => command.type === "ui.conversation.check-agents")).toHaveLength(2);
    // The last projection stayed on screen all the while.
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("says the connection is lost after the backoff gives up, and sends nothing more", async () => {
    vi.useFakeTimers();
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    for (let round = 0; round < 8; round += 1) {
      port.drop();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }
    expect(screen.getByRole("alert").textContent).toBe(ui("settings.connectionLost"));
  });
});

describe("the connector: the address bar", () => {
  it("opens the section the hash names, with its parameters", async () => {
    window.location.hash = "#sites?site=https%3A%2F%2Fgithub.com";
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(ui("settings.nav.sites"));
    expect(document.querySelector("[data-site='https://github.com']")?.className).toContain("flash");
  });

  it("writes the hash when a section is chosen, and follows it when it changes by itself", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ui("settings.nav.tools")) }));
    expect(window.location.hash).toBe("#tools");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(ui("settings.nav.tools"));
    act(() => {
      window.location.hash = "#connection";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(ui("settings.nav.connection"));
  });
});

describe("the connector: the appearance", () => {
  it("reads the stored appearance and follows a change in storage", async () => {
    const port = installChrome({ appearance: { theme: "dark", language: "zh-TW" } });
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title", {}, "zh-TW"));
    port.changeStorage({ theme: "light", language: "en-US" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title"));
  });

  it("follows the browser's UI language when the language is System", async () => {
    const port = installChrome({ language: "zh-TW" });
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title", {}, "zh-TW"));
  });

  it("applies a choice once the worker has taken it", async () => {
    const port = installChrome();
    await mount();
    port.emit({ type: "worker.settings.state", payload: prototypeAState(NOW) });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(ui("settings.themeLabel")), { target: { value: "dark" } });
    });
    const command = settingsCommandSchema.parse(port.last());
    expect(command).toMatchObject({ type: "ui.settings.appearance-set", payload: { theme: "dark" } });
    await act(async () => {
      port.reply(command.commandId);
      await Promise.resolve();
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
