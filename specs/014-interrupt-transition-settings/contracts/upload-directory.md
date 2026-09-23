# Contract: ask before uploading from a new directory (feature 014, S3)

Lives in `packages/contracts/src/agent-tools.ts` (control and link frames, prompt kind and
fields, reasons, panel state and messages), `packages/agent-host/src/{mcp-server.ts,
upload-policy.ts, upload-config-store.ts, relay-mux.ts}` and the worker's bridge/runtime/panel;
this file is the readable statement the tests pin. Link protocol number unchanged: every frame
below is a new type (unknown-and-dropped by an old side) and `features` is optional.

## Capability advertisement

`pair-result.features?: string[]` — the worker sends `["upload-consent"]`. The host asks only a
worker that advertised it; otherwise the 0.5.0 refusal stands.

## Host flow on `file_upload`

```
resolveUploadFiles(paths, config)
  ok                      → args.files, send the call (as 0.5.0)
  outside-roots, feature  → upload-consent-request → await upload-consent-result (bound 125 s)
      once      → resolveUploadFiles(paths, config, { allowFiles: <those paths> }) → send
      always    → store.add(<non-root directories>) → resolveUploadFiles again → send
                  (a root directory is never added; its files ride `allowFiles`, and the answer
                   carries `UPLOAD_HINTS.rootNotRemembered`)
                  store could not write → { outcome: "denied",
                                            reason: "upload-directory-not-recorded", hint: <refusal> }
      deny      → { outcome: "denied", reason: "upload-declined" }
      timed-out → { outcome: "denied", reason: "upload-not-answered", hint? }
      interrupted → { outcome: "stopped", reason: "owner-interrupted", hint }
      busy      → { outcome: "busy", reason: "prompt-pending" }
  outside-roots, no feature → { outcome: "denied", reason: "upload-outside-allowed-directories" }
  link dropped while asking → { outcome: "failed", reason: "bridge-lost" }
  too-many-files / too-large / not-a-file → { outcome: "denied", reason: "upload-not-allowed" } (as 0.5.0)
```

`allowFiles` compares realpaths; it admits exactly the named files for this call and nothing
else. The directory question always precedes the site's own consent (the call has not crossed
the link yet).

**Root directories (S3 review F7).** `isRootDirectory` (contracts) is the shared rule: a drive
root (`D:\`), a UNC share root (`\\server\share`) or the POSIX root. `always` over one of them
uploads the files once and adds nothing - remembering it would answer every future question about
everything on that drive - and the answer says so in `UPLOAD_HINTS.rootNotRemembered`. The worker
reads the same rule, so it does not report such a directory as one the host failed to record.

**Progress (S3 review F1).** The call's progress token is registered *before* the `file_upload`
branch, so the worker's 011 prompt-waiting ticks for this card reach the client on the waiting
call's own token; the `finally` that clears it covers the whole call.

## Control frames

```
host → worker   upload-consent-request { sessionId, callId, files: [{ path, directory }] }
worker → host   upload-consent-result  { callId,
                                         decision: "once" | "always" | "deny" | "timed-out"
                                                 | "interrupted" | "busy",
                                         hint?: <ATTENTION_SENTENCES.consent, on a timed-out
                                                 question nobody could see> }
```

Worker: raises `AgentEffectPrompt { kind: "upload-directory", files, site: <the tab's site>, tool: "file_upload", ... }`;
the card shows each path **and the directory under it** - that is what "from now on" remembers
(S3 review F7). The panel answer `ui.agent.effect-decide { promptId, allow, rememberDirectory? }`
maps to `once` (allow) / `always` (allow + rememberDirectory) / `deny`; the 011 bound →
`timed-out` (with the closed-panel sentence as `hint`); an interrupt, a stop, a release or a
session ending → `interrupted`; a question already standing → `busy`; a session holding no tab →
`interrupted` (the card was never raised, so it is not a decline). The prompt-waiting ticks of 011
apply (the agent is told the owner is being asked; badge when the panel is closed).

## Roots listing and removal (relay ↔ worker, over the native port)

```
worker → relay  upload-roots-list   {}
worker → relay  upload-roots-remove { root }
relay → worker  upload-roots        { roots: string[], path: string, malformed?: boolean,
                                      preserved?: "config.json.invalid" }
```

The worker asks on `relay-ack` and after every consent result; the relay answers after every
change. `AgentPanelState.uploadRoots = { roots, path, malformed?, preserved?, notRecorded? }`
when known - `preserved` names the copy kept of a document nobody could read (S3 review F4), and
`notRecorded` is a directory the owner answered "from now on" about that the list came back
without (S3 review F2), which the panel says in a line of its own. Rows in the
site list show each root with a revoke → `ui.agent.upload-root-clear { root }` →
`upload-roots-remove`; while the relay has not answered, the row stays with a note and the
remove is re-sent on the next `relay-ack`. An old relay never answers: no `uploadRoots`, no rows.

## The store (`upload-config-store.ts`, the only writer of `config.json`)

`add(dirs)` / `remove(dir)`: read current → validate each candidate (absolute; `realpath`
resolves; is a directory) → merge, de-duplicate by realpath → write
`config.json.<pid>.<n>.tmp` → rename over `config.json` → answer the resulting list. Malformed
current content is treated as `[]` (as `readUploadConfig` does) and reported `malformed: true` on
`upload-roots`. Invalid candidates are refused with a reason and nothing is written.

**One temp file per write (S3 review F5).** The name carries this process's pid and a counter, so
several servers and the relay never write one another's temp file; a shared `config.json.tmp`
could be renamed over `config.json` half-written, which a fail-closed reader reads as "no
directories at all".

**The unreadable document is kept (S3 review F4).** Before the first write over content that could
not be parsed as a list, `config.json` is renamed to `config.json.invalid` (one copy, the newest,
replacing an older one) and the template plus the new roots are written. That write happens only
if the rename did. The answer carries `malformed: true` *and* `preserved: "config.json.invalid"`;
a plain `list()` carries `preserved` for as long as the copy is there, so the panel can say where
the owner's document went.

**A write that could not be made** answers `written: false` with a `write-failed` refusal per
candidate; the host turns that into `upload-directory-not-recorded` with the refusal as `hint`,
and the panel shows `uploadRoots.notRecorded` for the directory (S3 review F2).

## What the agent cannot do (contract-pinned)

The MCP tool surface (33 tools) contains no request that lists, adds or removes roots; the
control/link frames above are accepted only from the extension link (relay/worker), never
parsed from an MCP client message. Contract test (T381, rewritten by S3 review F8): every `.ts`
under the host's `src` is read from disk - not a typed-out list - and only `mcp-server.ts`,
`native-host.ts` and `relay-mux.ts` name the store module; the server makes exactly one store,
the only member it ever reaches on that binding is `.add(`, under the `decision === "always"`
guard, and the binding is never assigned or passed to a second name. The file path of the config
is not in any tool description or answer.

## Descriptions (contract-pinned sentence)

- `file_upload`: "A file outside the directories the owner allowed makes the owner's panel ask
  (this file once / its directory from now on / decline). `upload-outside-allowed-directories`
  means the owner's extension predates that question; `upload-not-allowed` for such a file means
  the owner's host does (reinstall it)."
