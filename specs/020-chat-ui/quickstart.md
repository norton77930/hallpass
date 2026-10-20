# Quickstart: validating 020

1. `npm install`, `npm run build`, reload the extension at `chrome://extensions`.
2. Open the side panel on any page. The Conversation tab shows an empty conversation with the cursor
   in the message box, the agent chip on the agent used last, the folder chip on the scratch folder
   and the mode chip on strict (US1).
3. Send "Summarise this page". The reply streams in, renders headings, lists, tables and code, and has
   Copy once it ends (US2). While it works, one live line says what the agent is doing; afterwards the
   actions fold into "N steps" (US3).
4. Ask for a file edit. The permission card appears above the message box, Enter does not send, only
   Stop is offered next to it; answering leaves a one-line record in the conversation (US4).
5. Open the conversation list from the header, search by title, open an older conversation, press
   Escape to close the list (US5).
6. Switch Windows to dark mode: both tabs follow; `npm test` includes the contrast check (US6).
7. Run the packaged gate as in `CONTRIBUTING.md`; only selectors changed in the conversation specs (US7).
