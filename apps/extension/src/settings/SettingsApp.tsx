import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  AGENT_SETTINGS_PORT_NAME,
  agentAppearanceSchema,
  settingsMessageSchema,
  type AgentAppearance,
  type ConversationAgent,
  type SettingsResult,
  type SettingsState,
  type SettingsToast,
} from "@hallpass/contracts";
import { SettingsView } from "./SettingsView.js";
import type { AgentOutput, SettingsCommandInput } from "./context.js";
import { formatRoute, parseRoute, type SettingsRoute } from "./routes.js";
import { makeTranslate, resolveLocale } from "./settings-text.js";

export { SettingsView } from "./SettingsView.js";
export type { SettingsViewProps } from "./SettingsView.js";
export { SettingsContext, useSettings } from "./context.js";
export type { AgentOutput, SendSettingsCommand, SettingsCommandInput } from "./context.js";

/**
 * How many times the page silently reconnects to a worker that keeps going away (the side panel's
 * number): an MV3 worker idling out is ordinary and reconnects at once; one that cannot be reached this
 * many times is not an idle, and the page says so instead of quietly doing nothing.
 */
const MAX_RECONNECT_ATTEMPTS = 6;
/** A command the worker never answers is given up on, so a button never waits for ever. */
const COMMAND_TIMEOUT_MS = 30_000;
/** Written by the service worker alone (`service-worker/agent-appearance.ts`); read and followed here. */
const APPEARANCE_STORAGE_KEY = "agentAppearance";
const DEFAULT_APPEARANCE: AgentAppearance = { theme: "system", language: "system" };

function parseAppearance(raw: unknown): AgentAppearance {
  const parsed = agentAppearanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_APPEARANCE };
}

function systemLanguage(): string {
  return globalThis.chrome?.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? "en-US";
}

/**
 * 024 R-372, R-373: the settings page's connector - the one place that touches `chrome.*`. It opens the
 * page's own port, keeps the latest projection, mints a `commandId` for each command and hands the
 * matching `worker.settings.result` back to whoever sent it, follows `location.hash`, and reads the
 * appearance from storage. Everything it shows is `SettingsView`'s.
 */
export function SettingsApp(): ReactElement {
  const [state, setState] = useState<SettingsState | undefined>(undefined);
  const [output, setOutput] = useState<Partial<Record<ConversationAgent, AgentOutput>>>({});
  const [toast, setToast] = useState<(SettingsToast & { seq: number }) | undefined>(undefined);
  const [lost, setLost] = useState(false);
  const [route, setRoute] = useState<SettingsRoute>(() => parseRoute(window.location.hash));
  const [appearance, setAppearance] = useState<AgentAppearance>(DEFAULT_APPEARANCE);

  const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
  const waiting = useRef(new Map<string, { resolve: (result: SettingsResult) => void; timer: ReturnType<typeof setTimeout> }>());
  const counter = useRef(0);
  const toasts = useRef(0);

  const refusal = (commandId: string, code: string): SettingsResult => ({ commandId, ok: false, error: { code } });

  const failWaiting = useCallback((code: string): void => {
    for (const [commandId, pending] of waiting.current) {
      clearTimeout(pending.timer);
      pending.resolve({ commandId, ok: false, error: { code } });
    }
    waiting.current.clear();
  }, []);

  const send = useCallback(
    (command: SettingsCommandInput): Promise<SettingsResult> => {
      counter.current += 1;
      const commandId = `s${counter.current}-${Date.now().toString(36)}`;
      return new Promise<SettingsResult>((resolve) => {
        const port = portRef.current;
        if (port === undefined) {
          resolve(refusal(commandId, "not-connected"));
          return;
        }
        const timer = setTimeout(() => {
          waiting.current.delete(commandId);
          resolve(refusal(commandId, "timeout"));
        }, COMMAND_TIMEOUT_MS);
        waiting.current.set(commandId, { resolve, timer });
        try {
          port.postMessage({ ...command, commandId });
        } catch {
          clearTimeout(timer);
          waiting.current.delete(commandId);
          resolve(refusal(commandId, "not-connected"));
        }
      }).then((result) => {
        // The choice is the page's own once the worker has taken it; storage's change event says the same later.
        if (result.ok && command.type === "ui.settings.appearance-set") {
          setAppearance((current) => ({
            theme: command.payload.theme ?? current.theme,
            language: command.payload.language ?? current.language,
          }));
        }
        return result;
      });
    },
    [],
  );

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) return undefined;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const onMessage = (message: unknown): void => {
      const parsed = settingsMessageSchema.safeParse(message);
      // Keep showing the last projection that parsed: a state nobody sent is not shown.
      if (!parsed.success) return;
      attempt = 0;
      setLost(false);
      const data = parsed.data;
      if (data.type === "worker.settings.state") {
        setState(data.payload);
      } else if (data.type === "worker.settings.result") {
        const pending = waiting.current.get(data.payload.commandId);
        if (pending === undefined) return;
        waiting.current.delete(data.payload.commandId);
        clearTimeout(pending.timer);
        pending.resolve(data.payload);
      } else if (data.type === "worker.settings.toast") {
        toasts.current += 1;
        setToast({ ...data.payload, seq: toasts.current });
      } else {
        const { agent, readAt, lines, conversationId } = data.payload;
        setOutput((current) => ({ ...current, [agent]: { readAt, lines, ...(conversationId === undefined ? {} : { conversationId }) } }));
      }
    };

    const connect = (): void => {
      if (disposed) return;
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: AGENT_SETTINGS_PORT_NAME });
      } catch {
        // A page orphaned by an extension reload has no worker it can ever reach again.
        setLost(true);
        return;
      }
      portRef.current = port;
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = undefined;
        // Reading it is what stops Chrome from logging the drop as unchecked.
        void chrome.runtime.lastError;
        // Nothing waiting on this connection is answered on the next one.
        failWaiting("not-connected");
        if (disposed) return;
        attempt += 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setLost(true);
          return;
        }
        retryTimer = setTimeout(connect, Math.min(250 * 2 ** (attempt - 1), 5000));
      });
      // R-374: what the helper reports is read fresh each time the page connects.
      void send({ type: "ui.conversation.check-agents", payload: {} });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      failWaiting("not-connected");
      portRef.current = undefined;
    };
  }, [failWaiting, send]);

  // R-372: the hash is the route; the page writes it when a section is chosen and follows it when it changes.
  useEffect(() => {
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // R-382: the stored appearance, and its changes.
  useEffect(() => {
    const area = globalThis.chrome?.storage?.local;
    let disposed = false;
    void Promise.resolve(area?.get([APPEARANCE_STORAGE_KEY]))
      .then((items) => {
        if (!disposed && items !== undefined) setAppearance(parseAppearance((items as Record<string, unknown>)[APPEARANCE_STORAGE_KEY]));
      })
      .catch(() => undefined);
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
      if (areaName !== "local" || !(APPEARANCE_STORAGE_KEY in changes)) return;
      setAppearance(parseAppearance(changes[APPEARANCE_STORAGE_KEY]?.newValue));
    };
    globalThis.chrome?.storage?.onChanged?.addListener(onChanged);
    return () => {
      disposed = true;
      globalThis.chrome?.storage?.onChanged?.removeListener(onChanged);
    };
  }, []);

  const language = systemLanguage();
  if (state === undefined) {
    const t = makeTranslate(resolveLocale(appearance.language, language));
    return (
      <div className="agent-shell settings-page">
        <main className="loading">
          {lost ? <p role="alert">{t("settings.connectionLost")}</p> : <p role="status">{t("settings.loading")}</p>}
        </main>
      </div>
    );
  }
  return (
    <SettingsView
      state={state}
      send={send}
      route={route}
      appearance={appearance}
      systemLanguage={language}
      output={output}
      toast={toast}
      lost={lost}
      onNavigate={(next) => {
        setRoute(next);
        window.location.hash = formatRoute(next);
      }}
    />
  );
}
