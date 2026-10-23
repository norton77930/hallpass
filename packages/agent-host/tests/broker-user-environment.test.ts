import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  USER_ENVIRONMENT_NAMES_QUERY,
  dotEnvNames,
  hermesHome,
  hermesKeyEnvName,
  keyNameOnlyInUserSettings,
  userEnvironmentNames,
  type UserEnvironmentPorts,
} from "../src/broker/user-environment.js";

/**
 * 023 T720 (R-369, D-023-6, FR-369/370): the names - and only the names - behind "a key the browser
 * cannot see": the variable Hermes' own `config.yaml` names in its `model:` block, the names its
 * `.env` defines, and the names under the signed-in user's environment settings, asked with a query
 * that prints names only. A value planted in each of those places never comes back out.
 */

const PLANTED = "sk-planted-VALUE-0123456789abcdef";
const HOME = "C:\\Users\\owner\\AppData\\Local\\hermes";

const CONFIG = [
  "# Hermes settings",
  "agent:",
  "  key_env: NOT_THE_MODEL_ONE",
  "model:",
  "  provider: custom",
  `  api_key: ${PLANTED}`,
  "  base_url: http://localhost:8000/v1",
  "  extra:",
  "    key_env: TOO_DEEP",
  "  key_env: MODEL_API_KEY   # the variable Hermes reads its key from",
  "toolsets:",
  "  - web",
].join("\n");

function ports(files: Record<string, string>, userNames: string[] = ["Path", "MODEL_API_KEY", "TEMP"]) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const port: UserEnvironmentPorts = {
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    run: async (file, args) => {
      runs.push({ file, args });
      return { code: 0, stdout: `${userNames.join("\r\n")}\r\n` };
    },
  };
  return { port, runs };
}

describe("023 T720 Hermes' home", () => {
  it("is HERMES_HOME when set, otherwise %LOCALAPPDATA%\\hermes, otherwise unknown", () => {
    expect(hermesHome({ HERMES_HOME: "D:\\hermes-home", LOCALAPPDATA: "C:\\x" })).toBe("D:\\hermes-home");
    expect(hermesHome({ LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" })).toBe(HOME);
    expect(hermesHome({})).toBeUndefined();
  });
});

describe("023 T720 the key variable's name from config.yaml", () => {
  it("is the model block's own key_env, not another block's or a deeper one", () => {
    expect(hermesKeyEnvName(CONFIG)).toBe("MODEL_API_KEY");
  });

  it("falls back to api_key_env, and takes a quoted name", () => {
    expect(hermesKeyEnvName("model:\n  api_key_env: \"OTHER_KEY\"\n")).toBe("OTHER_KEY");
    expect(hermesKeyEnvName("model:\r\n  api_key_env: 'OTHER_KEY'\r\n  key_env: FIRST_KEY\r\n")).toBe("FIRST_KEY");
  });

  it("is nothing without a model block, with a scalar model, or with something that is not a name", () => {
    expect(hermesKeyEnvName("agent:\n  key_env: X_KEY\n")).toBeUndefined();
    expect(hermesKeyEnvName("model: gpt-5\nkey_env: X_KEY\n")).toBeUndefined();
    expect(hermesKeyEnvName(`model:\n  key_env: ${PLANTED}\n`)).toBeUndefined();
    expect(hermesKeyEnvName("model:\n  key_env: MY KEY\n")).toBeUndefined();
    expect(hermesKeyEnvName("")).toBeUndefined();
  });
});

describe("023 T720 names in .env", () => {
  it("are the text before '=' only", () => {
    const names = dotEnvNames(`# keys\nMODEL_API_KEY=${PLANTED}\nexport OTHER = x\n\n  SPACED=1\nnot a line\n=nameless\n`);
    expect(names).toEqual(["MODEL_API_KEY", "OTHER", "SPACED"]);
    expect(JSON.stringify(names)).not.toContain(PLANTED);
  });
});

describe("023 T720 the user's environment names", () => {
  it("come from a query that prints names only - never reg query, which prints values", async () => {
    const { port, runs } = ports({});
    expect(await userEnvironmentNames(port)).toEqual(["Path", "MODEL_API_KEY", "TEMP"]);
    expect(runs).toEqual([{ file: USER_ENVIRONMENT_NAMES_QUERY.file, args: USER_ENVIRONMENT_NAMES_QUERY.args }]);
    expect(USER_ENVIRONMENT_NAMES_QUERY.file.toLowerCase()).toMatch(/powershell(\.exe)?$/u);
    expect(USER_ENVIRONMENT_NAMES_QUERY.args.join(" ")).toContain("GetValueNames()");
    expect(`${USER_ENVIRONMENT_NAMES_QUERY.file} ${USER_ENVIRONMENT_NAMES_QUERY.args.join(" ")}`).not.toMatch(/\breg(\.exe)?\b|GetValue\(/iu);
  });

  it("run Windows PowerShell by its full path under SystemRoot, not through PATH or the working folder", async () => {
    const { port, runs } = ports({});
    await userEnvironmentNames(port);
    const expected = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    expect(runs.map((run) => run.file)).toEqual([expected]);
    expect(win32.isAbsolute(runs[0]!.file)).toBe(true);
  });

  it("are none when the query fails or prints something that is not a name", async () => {
    const failing: UserEnvironmentPorts = { readText: async () => "", run: async () => ({ code: 1, stdout: "MODEL_API_KEY\r\n" }) };
    expect(await userEnvironmentNames(failing)).toEqual([]);
    const throwing: UserEnvironmentPorts = { readText: async () => "", run: async () => Promise.reject(new Error("no powershell")) };
    expect(await userEnvironmentNames(throwing)).toEqual([]);
    const odd: UserEnvironmentPorts = { readText: async () => "", run: async () => ({ code: 0, stdout: `GOOD\r\nKEY=${PLANTED}\r\n` }) };
    expect(await userEnvironmentNames(odd)).toEqual(["GOOD"]);
  });
});

describe("023 T720 a key name only in the user's settings", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local", PATH: "C:\\Windows" };
  const config = win32.join(HOME, "config.yaml");
  const dotEnv = win32.join(HOME, ".env");

  it("is the name when the user's settings have it, the agent's environment does not, and .env does not", async () => {
    const { port } = ports({ [config]: CONFIG });
    expect(await keyNameOnlyInUserSettings(env, port)).toBe("MODEL_API_KEY");
  });

  it("is nothing when the agent's environment has it (any case), when .env defines it, or the user's settings lack it", async () => {
    expect(await keyNameOnlyInUserSettings({ ...env, model_api_key: PLANTED }, ports({ [config]: CONFIG }).port)).toBeUndefined();
    expect(await keyNameOnlyInUserSettings(env, ports({ [config]: CONFIG, [dotEnv]: `MODEL_API_KEY=${PLANTED}\n` }).port)).toBeUndefined();
    expect(await keyNameOnlyInUserSettings(env, ports({ [config]: CONFIG }, ["Path"]).port)).toBeUndefined();
  });

  it("is nothing without a config, a named variable, or a Hermes home - and the query is then not run", async () => {
    const none = ports({});
    expect(await keyNameOnlyInUserSettings(env, none.port)).toBeUndefined();
    expect(none.runs).toEqual([]);
    expect(await keyNameOnlyInUserSettings({}, ports({ [config]: CONFIG }).port)).toBeUndefined();
  });

  it("follows HERMES_HOME", async () => {
    const home = "D:\\hermes-home";
    const { port } = ports({ [win32.join(home, "config.yaml")]: "model:\n  key_env: MODEL_API_KEY\n" });
    expect(await keyNameOnlyInUserSettings({ ...env, HERMES_HOME: home }, port)).toBe("MODEL_API_KEY");
  });

  it("never returns a planted value, wherever it was planted", async () => {
    const results = [
      await keyNameOnlyInUserSettings(env, ports({ [config]: CONFIG, [dotEnv]: `OTHER=${PLANTED}` }).port),
      await keyNameOnlyInUserSettings({ ...env, SOMETHING: PLANTED }, ports({ [config]: CONFIG }).port),
    ];
    expect(results).toEqual(["MODEL_API_KEY", "MODEL_API_KEY"]);
    expect(JSON.stringify(results)).not.toContain(PLANTED);
  });
});
