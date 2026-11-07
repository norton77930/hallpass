---
name: hallpass
description: Use when a task needs the user's own Chrome through the Hallpass browser tools (tabs, reading pages, clicking, typing, screenshots). Explains how the tools fit together and how the user's consent works, so you wait for the user instead of failing or retrying.
---

# Working in the user's browser with Hallpass

Hallpass gives you the user's real Chrome: their profile, their sign-ins, what they see. Every
page-changing step is the user's to allow. Each tool's own description has the details; this page is
how they fit together.

## Order of work

1. **Look**: `tabs_context` lists the tabs and who holds each one. Open a tab with `tabs_create`, or ask
   the user before taking one of theirs with `tabs_claim`.
2. **Read before acting**: `read_page` (structure with element refs and field values), `get_page_text`,
   `find`, `screenshot`. Reading never asks the user. `get_page_text` returns what the user could see by
   scrolling; text the page hides is left out, but same-colour or very small text is still returned.
3. **Act**: `navigate`, `click`, `type`, `key`, `scroll`, `form_input`, `dialog`, and the others. Use the
   refs from your last read; read again after the page changes.
4. **Several steps on one tab**: `browser_batch`. **Several sites in one task**: `propose_sites` first.
5. **Finish**: close the tabs you opened (`tabs_close`) and give back the ones you took (`tabs_release`).

## How consent works

- **Pairing**: your first call shows a pairing card in the Hallpass side panel. Tell the user a card is
  waiting there (toolbar icon, or Alt+A) and wait. Pairing is asked once per browser.
- **Site modes**, chosen by the user for each site:
  - `ask` (the default): every page-changing action shows a consent card. Say what you are about to do
    and that the user is asked to approve it in the side panel.
  - `follow-a-plan`: a `browser_batch` is approved once as a plan; single actions still ask.
  - `skip-checks`: nothing is asked on that site.
- **Site plan**: for a task across several sites, `propose_sites` lets the user approve those sites once
  for this session; page actions on them then run without a card.
- **A site the user has not decided about**: when a step lands on one, the call says so and the user is
  asked at your next call on that tab.
- **Diagnostics** (`read_console`, `read_network`, `evaluate`) need a separate per-site grant from the
  user. **Uploads** outside the user's allowed folders are asked about.
- Waiting for a card is normal, not an error.

## When the answer is no

- **Declined card**: that is the user's answer. Tell the user which step was not done and ask how to
  continue. Do not send the same step again on your own.
- **Card timed out**: the user did not answer. Report it the same way; repeat the step only if the user
  asks you to.
- **Session ended, tabs taken back, or the step interrupted**: stop your browser work and say so.
- Never try to get around a card: no other tool, tab or route to do the same step. Never ask the user to
  switch a site to `skip-checks`; the site mode is the user's choice in the side panel.

## Good habits

- Say in one line what you will do before a page-changing step, so the card the user sees is expected.
- Password, one-time-code and payment-card fields read as redacted; ask the user to fill them.
- Prefer element refs over screen points; use `computer` only when the page structure does not
  describe the target.
- Several browsers connected: `list_browsers`, then `select_browser`, or `request_browser_choice` to let
  the user pick.
