import { describe, expect, it } from "vitest";
import { redact, redactedTail } from "../src/broker/redact.js";

/**
 * 019/R-326 - text the broker shows or logs from an agent's error, an installer's stderr or a log
 * line passes through one redactor. It must hide credentials and token-like runs, be safe to apply
 * twice (the broker log and the panel both redact), and leave paths and versions readable.
 */

const LONG_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const BASE64ISH = "dGhpcyBpcyBhIHRva2VuIHRoYXQgaXMgbG9uZyBlbm91Z2g0NTY3ODk=";

describe("redact (R-326)", () => {
  it("hides credentials in a URL and keeps the host readable", () => {
    expect(redact("fetch https://alice:s3cr3t@registry.example.com/pkg failed")).toBe(
      "fetch https://[redacted]@registry.example.com/pkg failed",
    );
    expect(redact("git+ssh://deploy:p%40ss@host:22/x.git")).toBe("git+ssh://[redacted]@host:22/x.git");
  });

  it("leaves a URL without credentials alone", () => {
    const text = "GET https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-1.13.1.tgz 404";
    expect(redact(text)).toBe(text);
  });

  it("hides Authorization header values and bare bearer tokens", () => {
    expect(redact("Authorization: Bearer abcDEF123456789xyz")).toBe("Authorization: [redacted]");
    expect(redact("authorization=Basic dXNlcjpwYXNz")).toBe("authorization=[redacted]");
    expect(redact("sent header Bearer abcDEF123456789xyz to server")).toBe("sent header Bearer [redacted] to server");
  });

  it("hides vendor-shaped keys", () => {
    expect(redact("key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt in use")).toBe("key [redacted] in use");
    expect(redact("key sk-proj1234567890abcdefgh")).toBe("key [redacted]");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end")).toBe("token [redacted] end");
    expect(redact("github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv")).toBe("[redacted]");
  });

  it("hides password= and token= style values, in queries and environment dumps", () => {
    expect(redact("GET /x?user=bob&password=hunter2&page=2")).toBe("GET /x?user=bob&password=[redacted]&page=2");
    expect(redact("ANTHROPIC_API_KEY=abc123 GITHUB_TOKEN=zzz9 PATH=C:\\bin")).toBe(
      "ANTHROPIC_API_KEY=[redacted] GITHUB_TOKEN=[redacted] PATH=C:\\bin",
    );
    expect(redact('{"password": "hunter2", "name": "x"}')).toBe('{"password": "[redacted]", "name": "x"}');
  });

  it("hides long hex and base64-looking runs (32 characters or more)", () => {
    expect(redact(`digest ${LONG_HEX} ok`)).toBe("digest [redacted] ok");
    expect(redact(`blob ${BASE64ISH}`)).toBe("blob [redacted]");
    expect(redact("npm ERR! integrity sha512-saCOTPYBK1iqWqJFAYHXbg3+zCoFXyZZFoqQAwdTWkbrZZPpAETr80QOnYr2l")).toBe(
      "npm ERR! integrity [redacted]",
    );
  });

  it("keeps ordinary paths, versions, package names and uuids readable", () => {
    for (const text of [
      "C:\\Users\\someone\\AppData\\Local\\hallpass\\agents\\claude-code\\0.81.2\\node_modules\\@agentclientprotocol\\claude-agent-acp",
      "tested with Claude Code 2.1.302, found 2.2.0-beta.1",
      "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      "this-is-a-very-long-kebab-case-name-without-any-digits-at-all",
      "conversation 3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b started",
      "Error: spawn ENOENT (exit code 3)",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("is idempotent", () => {
    const text = [
      "https://u:p@h.example/x",
      "Authorization: Bearer abcDEF123456789xyz",
      "Bearer abcDEF123456789xyz",
      "password=hunter2 token=abc",
      `hash ${LONG_HEX} ${BASE64ISH}`,
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const once = redact(text);
    expect(redact(once)).toBe(once);
    expect(once).not.toMatch(/hunter2|s3cr3t|abcDEF123456789xyz|AbCdEfGh|ghp_abc/);
  });

  it("returns the empty string unchanged", () => {
    expect(redact("")).toBe("");
  });

  it("redactedTail keeps the end, redacted before it is cut", () => {
    const text = `${"x ".repeat(200)}\nnpm ERR! password=hunter2\nnpm ERR! done`;
    const tail = redactedTail(text, 40);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.endsWith("npm ERR! done")).toBe(true);
    expect(redactedTail("short\n", 40)).toBe("short");
    expect(redactedTail("a=1 password=hunter2", 15)).not.toContain("hunter2");
  });
});
