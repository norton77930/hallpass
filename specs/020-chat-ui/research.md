# Research: A Side-Panel Conversation That Reads Like an Agent (020)

Numbering continues from 019 (R-331).

## R-332 Rendering agent replies as Markdown

- **Decision**: `react-markdown` with `remark-gfm` (tables, strikethrough, task lists, autolinks),
  exact pins. Raw HTML in a reply is not rendered (`skipHtml`), the default URL transform stays on
  (it drops `javascript:` and other unsafe schemes), links open in a new tab with
  `rel="noopener noreferrer"`, images are shown as a link to their address and never loaded, wide
  tables and code blocks scroll inside their own box.
- **Rationale**: the agent's text is untrusted (it can echo page content). A renderer that builds React
  elements from a syntax tree never assigns HTML, so nothing in a reply can run script or load a
  remote resource; the extension page's CSP needs no change because nothing evaluates code.
- **Alternatives**: a hand-written subset renderer (less code shipped, but every edge of the syntax
  becomes ours to get right); `marked` + a sanitiser (renders to an HTML string, the riskier shape).
- **Baseline (T584, 0.13.1 build)**: `side-panel.js` 490.97 kB / 94.20 kB gzip, `chunks/AgentShell.js`
  127.04 kB / 30.68 kB gzip. The size after is recorded when the renderer is first imported (T591);
  above about 150 KB gzip added, reconsider the table extension.
- **After (T591)**: `side-panel.js` 94.21 kB gzip (unchanged); `chunks/AgentShell.js` 689.89 kB / 146.58 kB gzip
  (+115.9 kB gzip). The extension build does not minify (`vite.config.ts`), so the renderer ships with
  its source comments; under the threshold, the table extension stays. Raw HTML in a reply is shown as
  text (react-markdown without `skipHtml` makes it a text node), as FR-316 asks.
- **Dependency tree**: 100 packages from the unified, micromark, mdast and hast families, all MIT
  except `@ungap/structured-clone` (ISC); named in `THIRD_PARTY_NOTICES.md`.

## R-333 Streaming text and Markdown

- **Decision**: re-render the growing reply on each coalesced chunk (the broker already caps text
  frames at one per 50 ms, T537). An unclosed code fence renders as a code block to the end of the
  text until the fence closes.
- **Rationale**: a reply is short enough that re-parsing per frame is cheap; the list keeps itself
  pinned to the bottom only when the owner is already at the bottom, so nothing above the reading
  position jumps.

## R-334 Grouping actions by turn

- **Decision**: a turn is everything between one owner message and the next. While the turn runs,
  the newest running action is the live line; when it ends, the actions collapse to "N steps".
  Failed and refused actions are listed after the collapsed group so they are never hidden. A pure
  function in `conversation-log.ts`, unit-tested.
- **Rationale**: the action log is the main source of noise in today's view; the owner needs what is
  happening now and what went wrong, not every successful read.

## R-335 Which agent the composer starts on

- **Decision**: the agent of the most recently started conversation, kept as a panel preference in
  `chrome.storage.local` next to the remembered tab (019 FR-284). When that agent is not ready, the
  first ready agent in the fixed order; when none is ready, the first agent with its install note.
- **Rationale**: the owner asked why they must pick an agent before typing; most people use one agent
  most of the time.
