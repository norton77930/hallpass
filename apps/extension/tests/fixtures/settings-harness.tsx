import { useState, type ReactElement } from "react";
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { afterEach, vi, type Mock } from "vitest";
import {
  settingsCommandSchema,
  type AgentAppearance,
  type ConversationAgent,
  type SettingsResult,
  type SettingsState,
} from "@hallpass/contracts";
import { lookup } from "../../src/locales/catalog.js";
import { SettingsView, type SettingsViewProps } from "../../src/settings/SettingsApp.js";
import type { SettingsCommandInput } from "../../src/settings/context.js";
import { formatRoute, type SettingsRoute } from "../../src/settings/routes.js";
import { prototypeAState } from "./settings-prototype-a.js";

/**
 * 024 S3: the settings page's view under jsdom. The view is pure - a state, a way to send, a route and
 * an appearance - so a test hands it exactly those: the prototype-A projection (a fixed day, so
 * "today" and "yesterday" are stable), a `send` that records every command and answers `ok`, and a
 * route the harness keeps the way the connector keeps `location.hash`.
 */

// The suite runs without vitest globals, so testing-library cannot unmount by itself.
afterEach(cleanup);

export const NOW = new Date(2026, 9, 24, 12, 0, 0);
export const DEFAULT_APPEARANCE: AgentAppearance = { theme: "system", language: "en-US" };

/** The English text of a key, with `{name}` placeholders filled. */
export const ui = (key: string, vars: Record<string, string | number> = {}, locale: "en-US" | "zh-TW" = "en-US"): string =>
  lookup(key, locale).replace(/\{([a-zA-Z]+)\}/gu, (whole, name: string) => (name in vars ? String(vars[name]) : whole));

export type SendMock = Mock<(command: SettingsCommandInput) => Promise<SettingsResult>>;

export function okSend(result: Partial<SettingsResult> = {}): SendMock {
  return vi.fn(async () => ({ commandId: "test", ok: true, ...result }) as SettingsResult);
}

/** A send the worker refuses: the result is `ok: false`. */
export function refusedSend(): SendMock {
  return vi.fn(async () => ({ commandId: "test", ok: false, error: { code: "refused" } }) as SettingsResult);
}

export type Harness = RenderResult & {
  send: SendMock;
  routes: SettingsRoute[];
  /** Re-render with a new projection, as the worker sends one. */
  project(state: SettingsState): void;
  update(props: Partial<SettingsViewProps>): void;
  /** Every command sent, as the connector would put it on the port (with a commandId). */
  commands(): Array<ReturnType<typeof settingsCommandSchema.parse>>;
};

export function renderSettings(
  options: Partial<Omit<SettingsViewProps, "route" | "send">> & {
    route?: SettingsRoute | string;
    send?: SendMock;
  } = {},
): Harness {
  const send = options.send ?? okSend();
  const routes: SettingsRoute[] = [];
  let props: SettingsViewProps = {
    state: prototypeAState(NOW),
    appearance: DEFAULT_APPEARANCE,
    now: () => NOW,
    ...options,
    send,
    route: typeof options.route === "string" ? { section: options.route as SettingsRoute["section"] } : (options.route ?? { section: "agents" }),
  };
  let setProps: (next: SettingsViewProps) => void = () => undefined;

  function Host(): ReactElement {
    const [current, set] = useState(props);
    setProps = set;
    return (
      <SettingsView
        {...current}
        onNavigate={(route) => {
          routes.push(route);
          set((previous) => ({ ...previous, route }));
        }}
      />
    );
  }

  const rendered = render(<Host />);
  const apply = (next: Partial<SettingsViewProps>): void => {
    props = { ...props, ...next };
    act(() => setProps(props));
  };
  return Object.assign(rendered, {
    send,
    routes,
    project: (state: SettingsState) => apply({ state }),
    update: apply,
    commands: () => send.mock.calls.map(([command]) => settingsCommandSchema.parse({ ...command, commandId: "t" })),
  });
}

/** The hash a route would carry, for a test that checks what the page puts in the address bar. */
export const hashOf = formatRoute;

export function agentEntry(state: SettingsState, agent: ConversationAgent): SettingsState["agents"][number] {
  const entry = state.agents.find((item) => item.agent === agent);
  if (entry === undefined) throw new Error(`no ${agent} in the fixture`);
  return entry;
}

/** A projection where one agent's entry is replaced. */
export function withAgent(
  state: SettingsState,
  agent: ConversationAgent,
  change: (entry: SettingsState["agents"][number]) => SettingsState["agents"][number],
): SettingsState {
  return { ...state, agents: state.agents.map((entry) => (entry.agent === agent ? change(entry) : entry)) };
}
