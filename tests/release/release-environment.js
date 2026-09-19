import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REQUIRED = [
  "CHROME_CURRENT_PATH",
  "CHROME_PREVIOUS_PATH",
  "CHROME_CURRENT_MAJOR",
  "CHROME_PREVIOUS_MAJOR",
];

export function parseBrowserMajor(productVersion) {
  return /^\s*(\d+)\./.exec(productVersion)?.[1];
}

export function releaseMatrixProfiles(release) {
  return [
    { channel: "current", major: release.CHROME_CURRENT_MAJOR, locale: "en-US", executablePath: release.CHROME_CURRENT_PATH },
    { channel: "current", major: release.CHROME_CURRENT_MAJOR, locale: "zh-TW", executablePath: release.CHROME_CURRENT_PATH },
    { channel: "previous", major: release.CHROME_PREVIOUS_MAJOR, locale: "en-US", executablePath: release.CHROME_PREVIOUS_PATH },
    { channel: "previous", major: release.CHROME_PREVIOUS_MAJOR, locale: "zh-TW", executablePath: release.CHROME_PREVIOUS_PATH },
  ];
}

function readWindowsBrowserMajor(path) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Item -LiteralPath $env:HALLPASS_RELEASE_BROWSER_PATH).VersionInfo.ProductVersion",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, HALLPASS_RELEASE_BROWSER_PATH: path },
    },
  );
  if (result.status !== 0) {
    return undefined;
  }
  return parseBrowserMajor(result.stdout);
}

export function validateReleaseEnvironment(
  source,
  fileExists = existsSync,
  readMajor = readWindowsBrowserMajor,
) {
  if (source.HALLPASS_E2E !== "1") {
    return { ok: false, reason: "release-harness-disabled: set HALLPASS_E2E=1" };
  }
  const values = Object.fromEntries(
    REQUIRED.map((name) => [name, source[name]?.trim() ?? ""]),
  );
  const missing = REQUIRED.filter((name) => values[name].length === 0);
  if (missing.length > 0) {
    return { ok: false, reason: `release-environment-missing: ${missing.join(",")}` };
  }
  if (!/^\d+$/.test(values.CHROME_CURRENT_MAJOR) || !/^\d+$/.test(values.CHROME_PREVIOUS_MAJOR)) {
    return { ok: false, reason: "release-major-invalid" };
  }
  if (values.CHROME_CURRENT_MAJOR === values.CHROME_PREVIOUS_MAJOR) {
    return { ok: false, reason: "release-majors-must-be-distinct" };
  }
  for (const name of ["CHROME_CURRENT_PATH", "CHROME_PREVIOUS_PATH"]) {
    if (!fileExists(values[name])) {
      return { ok: false, reason: `release-browser-missing: ${name}` };
    }
  }
  for (const [pathName, majorName] of [
    ["CHROME_CURRENT_PATH", "CHROME_CURRENT_MAJOR"],
    ["CHROME_PREVIOUS_PATH", "CHROME_PREVIOUS_MAJOR"],
  ]) {
    const actualMajor = readMajor(values[pathName]);
    if (actualMajor === undefined) {
      return { ok: false, reason: `release-browser-version-unreadable: ${pathName}` };
    }
    if (actualMajor !== values[majorName]) {
      return { ok: false, reason: `release-major-mismatch: ${majorName}` };
    }
  }
  return { ok: true, value: { ...values, HALLPASS_E2E: "1" } };
}
