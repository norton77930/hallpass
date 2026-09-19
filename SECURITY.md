# Security policy

Hallpass runs inside the browser you are logged into and lets a local program act on it. A
vulnerability here can expose what you see in your tabs, so please report one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for anything that could be exploited.

Please include what you were able to do, on which version (`VERSION` in the zip, or the commit),
and the steps. You will get an acknowledgement within a week and a fix or a decision within a
month; we will credit you in the release notes unless you ask otherwise.

## Supported versions

The latest release on the [releases page](../../releases) receives fixes. Older zips do not.

## What is in scope

- The extension (`apps/extension`): consent bypasses, a page reaching the extension's off-screen
  document or the agent's tools, data leaving the page that the consent model says stays.
- The MCP server and relay (`packages/agent-host`): another local process reaching a session it does
  not own, the upload-root boundary, the native-host pairing.
- The installer scripts.

Out of scope: anything that requires an already-compromised browser profile or machine, and the
behaviour of the coding agent that calls the tools.
