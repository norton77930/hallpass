import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { PANEL_MCP_AGENTS, PANEL_MCP_SERVERS_MAX, type PanelMcpServer, type PanelMcpServerList, type PanelMcpServerView } from "@hallpass/contracts";
import { useSettings } from "../context.js";

type PanelMcpAgent = (typeof PANEL_MCP_AGENTS)[number];

/**
 * 027 (D-027-1, D-027-2, FR-425..FR-432): the extra MCP servers for side-panel conversations, below the
 * browser-tools table. One list; each server says which agents get it (all ticked when added), each
 * variable set or not (never its value), and its last Check. Adding, editing and Check go to the helper;
 * Remove asks first, as a site's Revoke does. The list follows the next projection after each change.
 */
export function McpServersBlock(props: { list: PanelMcpServerList }): ReactElement {
  const { t } = useSettings();
  /** Which form is open: a new server, the server of that name, or none. */
  const [editing, setEditing] = useState<{ previous?: PanelMcpServerView } | undefined>(undefined);
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const { servers } = props.list;
  const full = servers.length >= PANEL_MCP_SERVERS_MAX;
  return (
    <section className="mcp-block blk" data-section="mcp-servers" aria-labelledby="mcp-title">
      <h3 id="mcp-title">{t("settings.mcp.title")}</h3>
      <p className="meta">{t("settings.mcp.intro")}</p>
      <p className="note warn">{t("settings.mcp.warning")}</p>
      {props.list.unreadable === true ? <p className="note warn">{t("settings.mcp.unreadable")}</p> : null}
      {editing !== undefined && editing.previous === undefined ? (
        <ServerForm servers={servers} onDone={() => setEditing(undefined)} />
      ) : null}
      {servers.length === 0 ? (
        props.list.unreadable === true ? null : <p className="meta">{t("settings.mcp.empty")}</p>
      ) : (
        <ul className="mcp-rows">
          {servers.map((server) =>
            editing?.previous?.name === server.name ? (
              <li key={server.name}>
                <ServerForm servers={servers} previous={server} onDone={() => setEditing(undefined)} />
              </li>
            ) : (
              <ServerRow
                key={server.name}
                server={server}
                confirming={confirming === server.name}
                onConfirm={(on) => setConfirming(on ? server.name : undefined)}
                onEdit={() => setEditing({ previous: server })}
              />
            ),
          )}
        </ul>
      )}
      <div>
        <button
          type="button"
          className="btn"
          disabled={full || props.list.unreadable === true || editing !== undefined}
          onClick={() => setEditing({})}
        >
          {t("settings.mcp.add")}
        </button>
        {full ? <span className="meta"> {t("settings.mcp.full", { max: PANEL_MCP_SERVERS_MAX })}</span> : null}
      </div>
      <p className="meta">{t("settings.mcp.deepseek")}</p>
    </section>
  );
}

function ServerRow(props: { server: PanelMcpServerView; confirming: boolean; onConfirm: (on: boolean) => void; onEdit: () => void }): ReactElement {
  const { t, run, nameOf } = useSettings();
  const { server } = props;
  const remove = useRef<HTMLButtonElement>(null);
  const confirmYes = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (props.confirming) confirmYes.current?.focus();
    else if (wasConfirming.current) remove.current?.focus();
    wasConfirming.current = props.confirming;
  }, [props.confirming]);

  const check = server.check;
  return (
    <li className="mcp-row" data-server={server.name}>
      <div className="mcp-head">
        <strong>{server.name}</strong>
        <span className="mcp-actions">
          <button
            type="button"
            className="btn"
            disabled={server.checking === true}
            onClick={() => {
              void run({ type: "ui.conversation.mcp-server-check", payload: { name: server.name } });
            }}
          >
            {t(server.checking === true ? "settings.mcp.checking" : "settings.mcp.check")}
          </button>
          <button type="button" className="btn quiet" onClick={props.onEdit}>
            {t("settings.mcp.edit")}
          </button>
          <button ref={remove} type="button" className="btn quiet" onClick={() => props.onConfirm(true)}>
            {t("settings.mcp.remove")}
          </button>
        </span>
      </div>
      <code className="mcp-command">{[server.command, ...server.args].join(" ")}</code>
      <span className="meta">{server.agents.map((agent) => nameOf(agent)).join(" · ")}</span>
      {server.variables.length === 0 ? null : (
        <span className="meta mcp-vars">
          {server.variables.map((variable) => (
            <span key={variable.name} className={variable.set ? "var-set" : "var-unset"}>
              {t(variable.set ? "settings.mcp.variableSet" : "settings.mcp.variableUnset", { name: variable.name })}
            </span>
          ))}
        </span>
      )}
      {check === undefined ? null : check.outcome === "works" ? (
        <span className="mcp-check ok">{t("settings.mcp.works", { tools: check.tools.join(", "), count: check.toolCount })}</span>
      ) : (
        <span className="mcp-check bad">{t("settings.mcp.failed", { reason: check.detail })}</span>
      )}
      {server.codexSkipped === true ? <span className="meta">{t("settings.mcp.codexSkipped")}</span> : null}
      {props.confirming ? (
        <div className="site-confirm" role="alert">
          <span>{t("settings.mcp.removeConfirm", { name: server.name })}</span>
          <button
            ref={confirmYes}
            type="button"
            className="btn danger"
            onClick={() => {
              props.onConfirm(false);
              void run({ type: "ui.conversation.mcp-server-remove", payload: { name: server.name } });
            }}
          >
            {t("settings.mcp.remove")}
          </button>
          <button type="button" className="btn" onClick={() => props.onConfirm(false)}>
            {t("settings.mcp.keep")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/u;

/** R-418, checked here first so the owner hears why at the field; the helper checks again. */
function problemOf(server: PanelMcpServer, others: readonly PanelMcpServerView[]): string | undefined {
  if (server.name.toLowerCase().startsWith("hallpass")) return "settings.mcp.error.reserved";
  if (!NAME.test(server.name)) return "settings.mcp.error.name";
  if (others.some((entry) => entry.name.toLowerCase() === server.name.toLowerCase())) return "settings.mcp.error.duplicate";
  if (server.command.trim() === "" || server.command.length > 400) return "settings.mcp.error.command";
  if (server.args.length > 30 || server.args.some((arg) => arg.length > 400)) return "settings.mcp.error.args";
  if (server.variables.length > 10 || server.variables.some((name) => !VARIABLE.test(name))) return "settings.mcp.error.variables";
  if (server.agents.length === 0) return "settings.mcp.error.agents";
  return undefined;
}

function ServerForm(props: { servers: readonly PanelMcpServerView[]; previous?: PanelMcpServerView; onDone: () => void }): ReactElement {
  const { t, run, nameOf } = useSettings();
  const ids = { name: useId(), command: useId(), args: useId(), variables: useId(), problem: useId() };
  const previous = props.previous;
  const [name, setName] = useState(previous?.name ?? "");
  const [command, setCommand] = useState(previous?.command ?? "");
  const [args, setArgs] = useState(previous?.args.join("\n") ?? "");
  const [variables, setVariables] = useState(previous?.variables.map((variable) => variable.name).join(", ") ?? "");
  const [agents, setAgents] = useState<readonly PanelMcpAgent[]>(previous?.agents ?? PANEL_MCP_AGENTS);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const server: PanelMcpServer = {
      name: name.trim(),
      command: command.trim(),
      args: args
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      variables: variables.split(/[\s,]+/u).filter((part) => part !== ""),
      agents: PANEL_MCP_AGENTS.filter((agent) => agents.includes(agent)),
    };
    const found = problemOf(
      server,
      props.servers.filter((entry) => entry.name !== previous?.name),
    );
    setProblem(found);
    if (found !== undefined) return;
    void run(
      { type: "ui.conversation.mcp-server-save", payload: { server, ...(previous === undefined ? {} : { previousName: previous.name }) } },
      () => props.onDone(),
    );
  };

  return (
    <form className="mcp-form" aria-label={t("settings.mcp.formTitle")} onSubmit={submit} noValidate>
      <label htmlFor={ids.name}>{t("settings.mcp.field.name")}</label>
      <input ref={first} id={ids.name} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.command}>{t("settings.mcp.field.command")}</label>
      <input id={ids.command} value={command} maxLength={400} onChange={(event) => setCommand(event.target.value)} />
      <label htmlFor={ids.args}>{t("settings.mcp.field.args")}</label>
      <textarea id={ids.args} rows={3} value={args} aria-describedby={`${ids.args}-hint`} onChange={(event) => setArgs(event.target.value)} />
      <span id={`${ids.args}-hint`} className="meta">
        {t("settings.mcp.argsHint")}
      </span>
      <label htmlFor={ids.variables}>{t("settings.mcp.field.variables")}</label>
      <input id={ids.variables} value={variables} aria-describedby={`${ids.variables}-hint`} onChange={(event) => setVariables(event.target.value)} />
      <span id={`${ids.variables}-hint`} className="meta">
        {t("settings.mcp.variablesHint")}
      </span>
      <fieldset className="mcp-agents">
        <legend>{t("settings.mcp.field.agents")}</legend>
        {PANEL_MCP_AGENTS.map((agent) => (
          <label key={agent}>
            <input
              type="checkbox"
              checked={agents.includes(agent)}
              onChange={(event) => setAgents((current) => (event.target.checked ? [...current, agent] : current.filter((item) => item !== agent)))}
            />
            {nameOf(agent)}
          </label>
        ))}
      </fieldset>
      {problem === undefined ? null : (
        <p id={ids.problem} className="note warn" role="status">
          {t(problem)}
        </p>
      )}
      <div className="mcp-form-actions">
        <button type="button" className="btn" onClick={props.onDone}>
          {t("settings.mcp.cancel")}
        </button>
        <button type="submit" className="btn primary">
          {t("settings.mcp.save")}
        </button>
      </div>
    </form>
  );
}
