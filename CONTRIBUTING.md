# Contributing to Hallpass

Thanks for looking. This page is what you need to build, test and send a change.

## Build

Windows 11, Node 24, Google Chrome.

```powershell
npm install
npx tsc -b                     # packages
npm run build                  # apps\extension\dist\agent
npm run agent-host:install     # register the native host pointing at this checkout (HKCU, no admin)
```

Load `apps\extension\dist\agent` at `chrome://extensions` (Developer mode → Load unpacked). After
a rebuild, reload the extension; the host does not need reinstalling unless the checkout moves.

The repository is npm workspaces: `apps/extension` (the extension), `packages/agent-host` (MCP
server, relay, installer, the side-panel conversation broker), `packages/contracts` (the tool contracts and wire schemas, shared),
`packages/domain`, `packages/test-kit`.

## Tests

Three suites run in CI on every push and pull request, none needs a browser:

```powershell
npm run typecheck
npm test                  # unit (vitest, node) + side-panel tests (jsdom)
npm run test:contract     # contract tests over the build config, the manifests and the bundled host
```

Two more need a real Chrome and are run locally before a release:

- **The packaged gate** (`tests/e2e/packaged/agent-*.spec.ts`) attaches to a Chrome you start with
  `--remote-debugging-port=9222` that has `apps/extension/dist/agent` loaded. Set
  `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222` and run
  `npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-recording.spec.ts --reporter=list`.
  To keep the run away from the bridge your everyday Chrome uses, start both the browser and the
  runner with `LOCALAPPDATA` pointed at a private directory and set
  `HALLPASS_FOREIGN_AGENT_SERVERS=allow`; the fixture refuses that flag with the default
  `LOCALAPPDATA`.
- **The acceptance probes** (`tests/acceptance/probe-004`) drive the bridge with a real coding-agent
  session (`claude -p`) against public pages and write a timestamped report. They cost API calls;
  run them for a release, not for every change.

### The side-panel conversation: the fake agent

The conversation broker (`packages/agent-host/src/broker.ts`, started by the relay, one per browser
run) drives the owner's own Claude Code or Codex over the Agent Client Protocol. Its tests and its
gate never need a real agent: `tests/harness/fake-acp-agent.ts` is a small stand-in that speaks the
ACP subset the broker uses (streamed text, permission requests, modes, session load, a crash, child
processes, calls to Hallpass's browser tools). It is not a model: each behaviour is chosen by a
keyword in the prompt or by an environment variable such as `FAKE_ACP_SCENARIO` (`claude` or `codex`
modes); the header of the file lists them. `FAKE_ACP_MODELS` chooses the model list it reports for the
model picker (`config`, `config-no-effort`, `models`, `none`, `refuse`, `effort-moves`), with invented
model names, and `FAKE_ACP_REQUEST_LOG` records every request it receives in order. Its own tests run with
`npx vitest run --project unit tests/harness/fake-acp-agent.test.ts`.

To put the fake agent behind the broker in the packaged gate, set these for the **browser's** process
(the broker is started by Chrome's native host), together with the private `LOCALAPPDATA` and
`HALLPASS_FOREIGN_AGENT_SERVERS=allow` described above:

- `HALLPASS_TEST_MODE=1` - without it the two variables below are ignored, so an installed host can
  never be pointed at a fake agent;
- `HALLPASS_BROKER_TEST_AGENT` - a JSON argv that replaces every agent launch, for example
  `["node","--experimental-strip-types","<checkout>/tests/harness/fake-acp-agent.ts"]`;
- `HALLPASS_BROKER_TEST_IDLE_MS` - shortens the 10-minute idle stop.

Then run the conversation spec, which skips itself unless all of this is in place:

```powershell
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-conversation.spec.ts --reporter=list
```

The same variables are honoured by the broker tests under `packages/agent-host/tests/broker-*.test.ts`
(for example `broker-job.test.ts`, which proves that no agent process outlives the broker). Real-agent runs (Claude Code and Codex, signed
in) are acceptance probes: they cost API calls and are run for a release, not for a change.

A change to product behaviour comes with the test that would have caught its absence: one focused
failing test first, then the smallest change that makes it pass.

## Two attempts, then stop

If a change fails its second attempt, do not try a third variant of the same guess. Stop, take one
measurement (a log line, a timing, a screenshot from the gate), write down what you learned, and
start again from that. This rule has saved more time on this project than any other.

## Clean-room boundary

Hallpass matches some *observable behaviour* of existing products (see
[docs/design-notes.md](docs/design-notes.md)). Do not copy or adapt source code, bundled code,
assets, identifiers, protocols or internal structure from any other browser extension or agent
product into this repository. If you studied one to understand a behaviour, describe the behaviour
in your own words in the design notes, and implement it independently. A contract test keeps
shipped source free of test tooling and of references to those products.

This holds for open-source projects too, whatever their licence: reading them, learning from their
approach and following public standards (such as the Agent Client Protocol) is fine, but code
Hallpass uses from them comes in as an installed dependency, never copied into this repository.

## Specifications

Every feature so far has a specification under `specs/` (a spec, a plan, research decisions, a
task list, and a coverage file that records how each requirement was verified). For a change that
adds or alters behaviour, add to the relevant spec's change log or open a new spec directory. For a
fix, the pull request description is enough.

## Sending a change

1. Fork, branch, make the change with its test.
2. Run the three CI suites locally; run the gate if you touched the extension or the host.
3. Open a pull request. Say what changed, what you ran, and what you did not run. CI must be green.

By contributing you agree that your contribution is licensed under the Apache License 2.0, like
the rest of the project.
