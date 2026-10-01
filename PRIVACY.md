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
- in `%LOCALAPPDATA%\hallpass\`: the link file the host uses to find itself, its configuration
  (for example the folders you allow uploads from) and a relay log that records status codes, never
  page content.

Removing the extension deletes its storage; `uninstall.ps1` (or deleting that folder) removes the
host's files.

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
