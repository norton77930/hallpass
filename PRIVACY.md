# Privacy policy

Hallpass is a Chrome extension and a local helper program that let a coding agent you run on your
own computer use your Chrome, one permission at a time. This policy covers the extension and the
helper ("the host") as published in this repository and on the Chrome Web Store.

## What Hallpass collects

Nothing. Hallpass has no server, no account, no analytics and no telemetry. Its author receives no
data from it, of any kind.

## What Hallpass handles on your computer

To do what your coding agent asks, the extension reads and acts on the pages of the tabs it works
in: page text and structure, form values, screenshots, console and network entries of those tabs,
and downloads it starts. It passes the answer to the host over Chrome native messaging, and the host
passes it to your coding agent over a loopback connection. None of this leaves your computer through
Hallpass.

Hallpass redacts password, hidden, one-time-code and payment-card field values before an answer
leaves the page.

Stored on your computer:

- in the extension's storage: your per-site decisions (which sites the agent may use, in which mode),
  the agents you paired and the side panel's preferences;
- in `%LOCALAPPDATA%\hallpass\` (the side-panel conversation's files are listed in the next section):
  the link file the host uses to find itself, its configuration
  (for example the folders you allow uploads from) and a relay log that records status codes, never
  page content.

Removing the extension deletes its storage; `uninstall.ps1` (or deleting that folder) removes the
host's files.

## The side-panel conversation

The side panel can also hold a conversation with a coding agent you installed yourself (Claude Code or
Codex). What Hallpass does and does not keep for it:

- **No conversation content is stored by Hallpass.** Your messages, the agent's answers and the page
  text it reads are held in the helper's memory only, for as long as the conversation is running, so a
  reopened side panel can show it; they are never written to disk by Hallpass. The agent keeps its own
  record of the conversation, where it always does, and replays it from there.
- **Hallpass keeps an index.** In `%LOCALAPPDATA%\hallpass\conversations.json`: for each recent
  conversation (up to 50, for 30 days) its title, the agent, the folder, the mode and when it was last
  used. The title is the first line of your first message, up to 120 characters; that is the one piece
  of your words Hallpass writes down. Removing a conversation from the list removes its entry.
- **Other files, none with conversation content.** `folders.json` (the project folders you added),
  `conversation-consent\` (your one-time consent to use this browser, per browser), `agents\` (the
  downloaded connector), `scratch\` (the working folder of each conversation, which can hold files the
  agent wrote; Hallpass never deletes it), `brokers\` (process bookkeeping) and `broker.log` (status
  codes and process ids, never conversation content). `uninstall.ps1` removes all of them except
  `scratch\`, which it keeps and reports.
- **One download, only after you agree.** The first time you use an agent, the side panel asks before
  downloading a small connector from the npm registry (`registry.npmjs.org`, or the registry your own
  npm is set up for). That request is the only network access Hallpass itself causes for this feature,
  and it carries no data of yours beyond what any `npm` download sends.
- **The agent uses its own login.** The agent runs with the sign-in and settings you already gave it.
  Hallpass does not read, copy or store them. What you write to the agent, and what its tools read
  (including pages read through Hallpass), goes to that agent's model provider under the provider's terms,
  as when you use the agent in a terminal.

## What leaves your computer — through your agent, not Hallpass

Whatever a tool answers goes to the coding agent you connected, and from there to the model provider
that agent uses, under that provider's terms — exactly as a file the agent reads would. Hallpass does
not choose, see or control that provider. Under the default **ask** mode, every page-changing action
on a site waits for your approval in the side panel.

## Changes

Changes to this policy are made in this file; its history is the record.

## Contact

Questions: open an issue at https://github.com/norton77930/hallpass/issues. Security reports: see
[SECURITY.md](SECURITY.md).
