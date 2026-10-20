/**
 * T608, T609: the broker's English sentences that the panel says in its own language.
 *
 * The broker's detail is already redacted (R-326) and is shown as it came when the panel has no
 * words for it. These are the details the broker builds from a fixed template, so the panel can
 * recognise the template and say it from the locale, keeping the variable part (the agent, the
 * path, the reason) as a value - or say nothing when the sentence only repeats the title the panel
 * already shows for the code. What the agent or a tool itself said (a stop reason, an npm log, its
 * own error text) is a value or stays as sent. The templates live in `packages/agent-host/src/broker/`:
 * `conversation.ts`, `commands.ts`, `agents.ts`, `folders.ts`.
 */

type T = (key: string) => string;

/** `<agent> was found, but \`--version\` did not print a version number.` (agentAvailability). */
const VERSION_UNREADABLE = /^.{1,80} was found, but `--version` did not print a version number\.$/u;

/** `<path> is not an existing folder.` (addExisting: a chosen or typed path that is no folder). */
const NOT_A_FOLDER = /^([\s\S]{1,1024}) is not an existing folder\.$/u;

/** The words for an agent's availability detail: the locale's, or the broker's own when it is not a known template. */
export function availabilityDetail(detail: string, agentName: string, t: T): string {
  return VERSION_UNREADABLE.test(detail) ? t("conversation.version.unreadable").replace("{agent}", () => agentName) : detail;
}

/** The typed or chosen path the broker said is no folder, or `undefined` for any other detail. */
export function notAFolderPath(detail: string): string | undefined {
  return NOT_A_FOLDER.exec(detail)?.[1];
}

/**
 * One template: what it looks like, the locale key it is said with (none: it only repeats the title
 * and is left out), and the placeholders its capture groups fill, in order. A template with a
 * placeholder whose group did not match (an exit code the broker had none of) is left out too.
 */
type Template = { pattern: RegExp; key?: string; values?: readonly string[] };

const LABEL = ".{1,80}";
const TEXT = "([\\s\\S]{1,1024})";

/** Details of a refused command, and of a notice that carries a `ConversationError` code. */
const ERROR_DETAILS: readonly Template[] = [
  // cannot-resume
  { pattern: new RegExp(`^(${LABEL}) no longer has this conversation\\.$`, "u"), key: "conversation.detail.noLongerHas", values: ["agent"] },
  { pattern: /^The agent can no longer continue this conversation\.$/u },
  // too-many-running: the title already says it, and the count is in the title
  { pattern: /^\d{1,3} conversations are already running or waiting for you; stop one or answer its card first\.$/u },
  // folder-missing
  { pattern: /^That folder is not in your folder list\.$/u, key: "conversation.detail.folderNotListed" },
  {
    pattern: new RegExp(`^The folder ${TEXT} does not exist any more(?:, so this conversation cannot continue)?\\.$`, "u"),
    key: "conversation.detail.folderGone",
    values: ["path"],
  },
  { pattern: /^This conversation's scratch folder was deleted, so it cannot continue\.$/u },
  { pattern: /^The conversation's scratch folder could not be created\.$/u, key: "conversation.detail.scratchFailed" },
  // agent-missing
  { pattern: new RegExp(`^${LABEL} was not found on this computer\\. Install it, sign in once, then try again\\.$`, "u") },
  { pattern: new RegExp(`^${LABEL} was not found on this computer; install it first\\.$`, "u") },
  // agent-version (an unreadable version) and the mode switch the agent refused (agent-version / agent-exited)
  { pattern: new RegExp(`^(${LABEL}) was found, but \`--version\` did not print a version number\\.$`, "u"), key: "conversation.version.unreadable", values: ["agent"] },
  { pattern: new RegExp(`^The agent did not change its mode: ${TEXT}$`, "u"), key: "conversation.detail.modeNotChanged", values: ["reason"] },
  // install-needed
  { pattern: new RegExp(`^The ${LABEL} connector has not been downloaded yet\\.$`, "u") },
  { pattern: new RegExp(`^The ${LABEL} connector needs to be downloaded again: ${TEXT}$`, "u"), key: "conversation.detail.redownload", values: ["reason"] },
  // consent-needed
  { pattern: /^Hallpass needs your one-time consent before it starts an agent or downloads its connector\.$/u },
  { pattern: /^You withdrew the side-panel agent's access to this browser; the agent was not started\.$/u, key: "conversation.detail.consentWithdrawn" },
  // broker-unavailable
  { pattern: /^Hallpass is shutting down\.$/u, key: "conversation.detail.shuttingDown" },
  { pattern: /^Hallpass could not continue this conversation\.$/u, key: "conversation.detail.cannotContinue" },
  { pattern: /^Hallpass could not save your answer\.$/u, key: "conversation.detail.answerNotSaved" },
  { pattern: /^Hallpass could not carry this out\.$/u, key: "conversation.detail.notCarriedOut" },
  { pattern: /^The folder dialog was left open too long and was closed; open it again\.$/u, key: "conversation.detail.dialogTimedOut" },
  { pattern: /^The folder dialog could not open\.$/u, key: "conversation.detail.dialogFailed" },
  { pattern: /^The folder dialog could not open \(exit (\d{1,10})\)\.$/u, key: "conversation.detail.dialogExit", values: ["code"] },
  { pattern: new RegExp(`^The folder dialog could not start: ${TEXT}$`, "u"), key: "conversation.detail.dialogStart", values: ["reason"] },
  // agent-exited: an exit while starting names its code; the rest repeat the title
  {
    pattern: new RegExp(`^${LABEL} the agent exited(?: \\(exit (\\d{1,10})\\))? while starting\\.$`, "u"),
    key: "conversation.notice.agent-exited.exit",
    values: ["code"],
  },
  { pattern: /^The agent is not running\.$/u },
  { pattern: /^The agent is not running; it starts in strict mode when the conversation continues\.$/u },
  { pattern: /^The agent that asked is no longer running\.$/u },
  // busy: still answering and already running repeat the title; starting and switching add to it
  { pattern: /^The agent of this conversation is already running\.$/u },
  { pattern: /^The agent is still answering; stop it or wait for the end of its turn(?:, then switch the mode)?\.$/u },
  { pattern: /^The agent of this conversation is still starting; send again in a moment\.$/u, key: "conversation.detail.starting" },
  { pattern: /^The conversation is already switching its mode; try again in a moment\.$/u, key: "conversation.detail.switching" },
  // in-use-elsewhere, not-found
  { pattern: /^This conversation is running in another browser\.$/u },
  { pattern: /^This conversation is not in the list any more\.$/u },
];

/** The text of notices the broker words in English with a code of its own, under no title. */
const NOTICE_TEXTS: Readonly<Record<string, readonly Template[]>> = {
  "no-once-option": [
    { pattern: /^The agent offered no one-time answer for this; Hallpass declined rather than answer for always\.$/u, key: "conversation.notice.no-once-option" },
  ],
  "mode-reload-failed": [
    {
      pattern: new RegExp(`^Hallpass could not reload the conversation in the new mode \\(${TEXT}\\); the agent was stopped\\.$`, "u"),
      key: "conversation.notice.mode-reload-failed",
      values: ["reason"],
    },
  ],
  "mode-reset-failed": [
    {
      pattern: new RegExp(`^Hallpass could not set the mode back \\(${TEXT}\\); the agent was stopped\\.$`, "u"),
      key: "conversation.notice.mode-reset-failed",
      values: ["reason"],
    },
  ],
};

/** `The agent ended its turn: <stop reason>.` under `stop-max_tokens`, `stop-refusal`, `stop-other`... */
const TURN_ENDED: Template = { pattern: new RegExp(`^The agent ended its turn: ${TEXT}\\.$`, "u"), key: "conversation.notice.turn-ended", values: ["reason"] };

/** The locale's words for a matching template: `null` left out, `undefined` no template matched. */
function say(templates: readonly Template[], text: string, t: T): string | null | undefined {
  for (const template of templates) {
    const match = template.pattern.exec(text);
    if (match === null) continue;
    if (template.key === undefined) return null;
    const names = template.values ?? [];
    if (names.some((_, index) => match[index + 1] === undefined)) return null;
    let words = t(template.key);
    names.forEach((name, index) => {
      words = words.replace(`{${name}}`, () => match[index + 1] ?? "");
    });
    return words;
  }
  return undefined;
}

/**
 * The detail to show under the title of a refusal (or of a notice with an error code): the locale's
 * words for a template the broker built, the broker's own text when it is not one (the agent's or a
 * tool's words), or `undefined` when the sentence only repeats the title.
 */
export function errorDetailWords(detail: string, t: T): string | undefined {
  const said = say(ERROR_DETAILS, detail, t);
  return said === null ? undefined : (said ?? detail);
}

/** The words for a notice the broker sent with a code of its own, or its own text when it is not a known template. */
export function noticeWords(code: string, text: string, t: T): string {
  const templates = code.startsWith("stop-") ? [TURN_ENDED] : (NOTICE_TEXTS[code] ?? []);
  return say(templates, text, t) ?? text;
}
