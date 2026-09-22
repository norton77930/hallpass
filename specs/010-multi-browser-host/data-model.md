# Data Model: Multi-Browser Native Host Registration

## Native-messaging root

| Field | Type | Notes |
| --- | --- | --- |
| browser | string | display name: Google Chrome, Chromium, Microsoft Edge, Brave |
| root | string | `HKCU\...\NativeMessagingHosts`, per-user, never `HKLM` |

Four rows, fixed at build time (R-154). Order is stable and is the order the installer prints.

## Host entry

| Field | Type | Notes |
| --- | --- | --- |
| key | string | `${root}\com.hallpass.host` — derived, one per root |
| value | string | absolute path of the host manifest; the key's default value (`/ve`) |

Identical value under every root. Written with `/f` (overwrite), so install is idempotent.

## Legacy entry

| Field | Type | Notes |
| --- | --- | --- |
| key | string | `${root}\<name>` where `<name>` ≠ the current host name |
| manifest | file | its default value points at a manifest whose `allowed_origins` is exactly Hallpass's extension origin |

Recognised by property (`isLegacyRegistration`), removed on install unless `--keep-legacy`; the
manifest's directory is reported, never deleted.

## Registration outcome (new, R-155 / R-157)

| Field | Type | Notes |
| --- | --- | --- |
| browser | string | from the root row |
| key | string | the key acted on |
| outcome | `written` \| `failed` \| `removed` \| `absent` | one per root per command |
| reason | string? | `reg.exe`'s message when `failed` |

State per command:

- `install`: each root → `written` or `failed`; exit code 1 if any `failed`.
- `uninstall`: each root → `removed` or `absent`; exit code 0 in both cases.
- legacy cleanup: each legacy entry found → `removed`; roots that cannot be listed are skipped
  silently (a root that does not exist has nothing legacy under it).
