# Contract: installer output (`node packages/agent-host/dist/install/cli.js <command>`)

The CLI is the only interface this feature changes. Lines are `stdout` unless marked; the exit
code is part of the contract.

## `install`

```
agent-host installed
  launcher: <path>
  manifest: <path>
  registry: <Google Chrome> HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hallpass.host
  registry: <Chromium> HKCU\Software\Chromium\NativeMessagingHosts\com.hallpass.host
  registry: <Microsoft Edge> HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.hallpass.host
  registry: <Brave> HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.hallpass.host
  removed earlier version's registration: <key>          (0..n lines, unless --keep-legacy)
  earlier version's files may be deleted by hand: <dir>  (0..n lines)
```

A root that could not be written is reported instead as, on `stderr`:

```
agent-host: failed to register <Browser> <key>
<reg.exe message>
```

and is **absent from the `registry:` lines on stdout**. Exit code: 0 when all four roots were
written, 1 when any failed (the others are still written).

## `uninstall`

```
agent-host uninstalled
  removed: <launcher path>
  removed: <manifest path>
  removed: <Browser> <key>        (for a key that existed)
  absent:  <Browser> <key>        (for a key that did not)
```

Exit code: 0 in both cases.

## `status`

```
agent-host status
  launcher: present|missing <path>
  manifest: present|missing <path>
  registry: present|missing <Browser> <key>      (four lines)
```

Exit code: 0.

## Invariants

- The browser name in angle brackets comes from the root table; the four lines appear in table order.
- No legacy host name appears anywhere in the installer's source or output except as the value
  `reg.exe` returned for a key being removed.
