# Design notes

Hallpass lets a coding agent (Claude Code, Codex CLI, Cursor, Claude Desktop, or any stdio MCP
client) drive the Chrome you already use, under your consent. This document records the design
choices behind it: which behaviours we chose to match from products that already exist, why, and
where we deliberately differ. It is written for contributors who want to know *why* before they
change *what*.

## Products we compared

Three products do something close to what Hallpass does. We used them as points of comparison for
observable behaviour — what a user or an agent can see happen — and nothing else.

- **Claude in Chrome** (Anthropic's browser extension): an assistant that drives the user's own
  Chrome from a side-panel chat. Closest in spirit; its agent-facing page tools and its recording
  of runs set most of the expectations below.
- **Codex** (OpenAI's browser extension): an assistant that drives the user's Chrome for a coding
  agent, with several concurrent sessions and per-tab leases.
- **chrome-devtools-mcp** (the Chrome team's MCP server): the tool most coding agents already
  install. It attaches to a Chrome started in developer mode, which means a separate profile
  without the user's logins, and hands the agent the whole browser once attached.

**Independence statement.** Hallpass is an independent implementation. No source code, bundled
code, asset, identifier, protocol or internal structure of any compared product was copied or
adapted; the comparison was made from behaviour that any user of those products can observe, and
every behaviour adopted is described here in those terms. Where the behaviour we wanted did not
exist in any of them, we designed it and measured it ourselves. A contract test keeps the shipped
source free of test tooling and of any reference to those products.

## What Hallpass is for

The two official MCP servers give an agent a browser; they do not give it *your* browser, and they
do not give you a say per action. The "extension + MCP" projects give the agent your logged-in
Chrome and, once connected, everything in it. Hallpass exists for the gap between those: the agent
works in your everyday Chrome, with your logins, and every site and every page-changing action is
gated by a decision you make in the side panel — once per site if you choose, every time if you
prefer. You can stop it, and you can take your tabs back.

## §1 Cursor and click delivery

**Adopted.** Inputs are delivered at the browser level, as pointer and keyboard events a page
cannot tell from a person's: the pointer moves to the target before every click and hover, one
keystroke per character, a glide rather than a jump, and a short pause on arrival before the
button goes down. A visible cursor stays on the page between actions and leaves when the session
releases the tab. Chrome's own "this browser is being controlled" bar is accepted as the price of
this fidelity; both browser assistants show it too.

**Why.** Pages that validate real interaction (focus handling, hover menus, `mousedown` before
`click`) break under synthetic DOM events. The glide and the pause are what make a recording of the
run readable: a tester can see where the agent is about to click before it does.

**Differs.** The page-edge glow that marks a controlled tab is ours; we chose a glow over a banner
so the page keeps its full height.

## §2 Recording: one frame per action, drawn on

**Adopted.** A recording is driven by the agent, not by a panel button. A frame is taken after
every page-changing action (and after every step of a batch, and after every explicit screenshot),
never after a read. Each frame is drawn on before encoding: what the agent did, the step counter, a
ring at the click point or an arrow along a drag, a progress bar, and a watermark naming the
extension and its version.

**Why.** A recording that is one frame per action is a storyboard of the run: each frame answers
"what did it just do and where". A time-based recording would be mostly identical frames and would
miss fast actions entirely. The overlay is what turns a slideshow into evidence a tester can attach
to a ticket.

**Differs.** The cap is 200 frames and reaching it is reported on every later answer, instead of
silently dropping the oldest frames. Frames are held in an off-screen page of the extension so a
service-worker restart does not lose them. Typed text is cut at 40 characters, and a value typed
into a password or payment-card field is drawn as `••••`. The export goes where the browser puts
downloads, under a name the agent may choose but a folder it may not.

## §3 Dialogs and consent chaining

**Designed here** — no compared product answers `alert`, `confirm` or `prompt` for the agent; one
auto-declines "leave this site?", one exposes an accept/dismiss action with no consent model.

The tab is modal while a native dialog is open, so every other tool on that tab answers
`blocked-by-dialog` immediately, carrying the dialog's type and text. The agent answers with a
`dialog` tool. Dismissing, and acknowledging an `alert`, never ask you. Accepting a `confirm` or
`prompt` is treated like a click: it is gated by the site's mode. To avoid asking twice for one
action under `ask`, an accept that follows an action you just approved on the same tab within one
second is shown as a notice rather than a blocking card. The dialog's text is always written to the
session's activity list in the panel. "Leave this site?" defaults to staying, and forcing through
it is itself a gated action. A dialog you opened yourself is never answered by the extension.

**Why.** QA flows are full of "are you sure?" confirms; before this, one confirm ended a run in a
25-second silence. Gating *accept* and not *dismiss* matches the asymmetry of risk. The one-second
chaining window was measured on a fixture page: a confirm opened by a click arrives well inside it.

**Interrupt** (0.6.0) is the other end of the same chain: a control that ends the step being run
and nothing else. One compared product ends its turn this way; the others offer only a stop that
ends everything. The step is answered within a second whatever it was waiting for — a `wait`, a
card nobody has answered, a batch step — and the pairing, the tabs and their group, the site modes,
an open recording and an emulated viewport all stay. The answer says it was the owner, and whether
anything had already been delivered to the page, so the agent can decide for itself whether the
step is safe to repeat; a batch reports how far it got. We did not add a per-call interrupt from a
list of in-flight calls: a person watching one session is deciding about *this step*, and picking a
call id out of a list is a decision they have no way to make.

**A move to another site** (0.6.0) is the first consent question here that no action of the agent's
asked for. A click lands, the page redirects, and the tab is suddenly on a site the owner has never
decided about — so the causing call reports the move in its own answer, and the *next* call on that
tab raises a card naming both origins: continue (this session), always (this pair, remembered and
revocable in the panel), or decline (this call only; the session and the question both stand). One
compared product pauses on a hostname change; we ask on origin, and we hold reads too, because a
read of a page nobody consented to is the disclosure the model exists to prevent. Calls that
*leave* — a navigation elsewhere, closing the tab, handing it back — are never held: an agent that
has landed somewhere it should not be must be able to go without waiting for a person.

**A file outside the owner's upload directories** (0.6.0) is the third question, and the one that
had been answered with a flat refusal since 0.3.0 — which in practice meant the owner editing a
JSON file by hand before the agent could be useful at all. The local host now holds the call and
the panel asks, naming every file in full *and the directory each sits in*, because "from now on"
remembers the directory rather than the file. Three answers: these files once, these directories
from now on, decline. Neither compared product asks this — one has no upload at all, the other
takes a path from the agent with no owner in the loop. The list remains writable only by the owner:
nothing in the agent's request surface reads it or widens it, and a drive or share root is never
added to it.

## §4 Tab groups, banner and ownership

**Adopted.** Each session's tabs live in their own tab group; a tab belongs to at most one live
session; a session asking for another session's tab is refused and told who holds it. Several
sessions may share one browser without coordinating. An in-page control lets you jump back to the
agent's main tab.

**Why.** Several coding-agent terminals against one Chrome is the normal case on a developer's
machine. Groups make ownership visible; leases make it enforceable.

**Differs.** The agent may *list* your tabs and take over the one you are looking at (a paired
agent is trusted to see what is open), but may only *read or act on* a tab it holds. **Release
tabs** hands a session's tabs back to you all at once while the session goes on; **Stop** ends it
and tells the agent you did.

## §5 Window sizing and restore

**Adopted, then corrected.** `resize_window` sizes the window that holds the session's tab and
reports the size the browser actually applied. A maximized or full-screen window is returned to
normal first, because the browser silently ignores a resize otherwise — one compared product
reports success in that case without changing anything; we report what happened.

**Designed here.** When the session releases its last tab in that window, or ends, the window goes
back to the state it was in. If the window was closed, nothing happens; if you re-maximized it by
hand, it is left alone; if two sessions resized it, the last to let go restores it; if you resized
it by hand after the agent did, your size wins. Measured: the restore lands within tens of
milliseconds, also after a service-worker restart.

## §6 Form values and downloads

**Adopted.** A read of the page includes each field's current value, so an agent can confirm what
it typed without a screenshot. Password and hidden fields, and any field whose autocomplete names a
password, a one-time code or a payment-card detail, are reported as *redacted*. Open shadow roots
are read; closed ones are not.

**Designed here.** The agent is told about the browser's downloads — name, source, state — and
never starts, opens, moves or deletes one. The file stays where the browser put it; the coding
agent reads it with its own file access. The extension's `downloads` permission is used for two
listeners and nothing else.

## §7 What we deliberately did not match

- **A chat in the side panel.** The conversation is in the coding agent's terminal; the panel is a
  status, consent and control surface only.
- **Clipboard access, plan editing, a native context menu on right-click.** Neither compared
  browser assistant does these, and the agent could not see a native menu anyway.
- **Silent frame dropping, in-memory frames, unmasked typed text** in recordings (§2).
- **Auto-answering "leave this site?"** — we default to staying and let the agent decide (§3).
- **A viewport override and zoom** shipped in 0.4.0: the viewport is *emulated* rather than the
  owner's window resized (the window is theirs, and a layout check is no reason to move it), the
  picture of an emulated tab is taken through the protocol at that viewport, a region is cropped at
  the picture's own density and `scale` asks for a smaller one; the emulation is cleared before the
  attachment is dropped on every release path, because we measured that a browser keeps it past a
  detach.
- **Image upload** shipped in 0.5.0, and it is the session's own screenshots rather than arbitrary
  bytes: every screenshot answer carries an id, the local MCP server keeps those bytes in its own
  process memory for five minutes under a per-session budget (nothing is written to disk, the
  browser never stores them, and another session is another process), and the agent quotes the id
  to put the picture into a page. Two delivery forms, because pages take a file in two ways: into a
  `<input type="file">` named by a reference — including one the page hides behind its own button —
  or as a drag-and-drop sequence at a viewport coordinate, one level into a same-origin frame. The
  upload is a page change, so it passes the same per-site consent a click does.
- **A settings or options page.** One compared product keeps its approved sites and transitions on
  one; we deliberately did not build one, because every decision here is made in the moment it
  arises, on a card that says what is about to happen, and taken back in the panel beside the site
  it belongs to — a page of switches is a place to grant something in the abstract, long before the
  thing it would allow.
- **Background visibility toggling and raw protocol pass-through** are out of scope by design: a
  tool that runs arbitrary protocol commands would undo the consent model.

## §8 A question the person cannot see

**Ours.** Pairing and consent are answered in the side panel, and Chrome opens the side panel only
on a user gesture (we measured a worker-initiated open being refused in every form). So when a
question is raised while no panel is open, three things happen: the agent is sent a fixed sentence
it can relay to the person at the terminal — the panel is closed, click the toolbar icon or press
Alt+A; the toolbar icon carries a red badge until the question is answered, expires or the panel
opens; and the question waits two minutes instead of the usual 25 or 45 seconds, with a progress
notice every five seconds so the agent's client sees activity. A question the person does answer
in time completes the original call; one they do not ends it as timed out with the same sentence.

**Why.** The first call of a new user is exactly when the panel is closed, and a timeout with no
instruction is the worst first impression a consent model can make. Both browser assistants keep
their pairing and permission UI inside the panel and have no mechanism for the closed case; we
chose the two zero-permission forms (words to the agent, a badge) over a system notification,
which would add a permission for a benefit the terminal already gives.

## Permissions

Every permission the extension declares traces to a capability above and to an acceptance
scenario: `nativeMessaging` (the local host), `tabs`/`tabGroups` (§4), `alarms` (reconnecting
after the worker is torn down), `debugger` (§1 input delivery, diagnostics behind a per-site
grant, dialog events for §3), `downloads` (§6, observe only), `offscreen` (§2 encoding, an
image-only page that makes no requests), `<all_urls>` (the agent drives the tabs you opened, on
any site). Nothing is requested for future work.
