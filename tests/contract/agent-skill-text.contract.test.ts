import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_SKILL_NAME, AGENT_SKILL_TEXT, SHIPPED_SKILL_HASHES, skillFingerprint } from "../../packages/agent-host/src/agent-skill.js";

/**
 * 026 T830 - the Hallpass skill as shipped (FR-413..416, FR-424, R-412, R-413): the readable copy in the
 * repository is the text the host installs; it is the last shipped fingerprint; and it says what an
 * outside agent must know - pairing, the site modes, and that a declined or timed-out card is not repeated.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const copy = readFileSync(join(ROOT, "skills", AGENT_SKILL_NAME, "SKILL.md"), "utf8");

describe("026 the shipped Hallpass skill", () => {
  it("R-413: skills/hallpass/SKILL.md is the host's text, and its fingerprint is the last shipped one", () => {
    expect(copy.replace(/\r\n/gu, "\n")).toBe(AGENT_SKILL_TEXT);
    expect(SHIPPED_SKILL_HASHES.at(-1)).toBe(skillFingerprint(AGENT_SKILL_TEXT));
    expect(new Set(SHIPPED_SKILL_HASHES).size).toBe(SHIPPED_SKILL_HASHES.length);
  });

  it("starts with the skill's name and a when-to-use description", () => {
    const front = /^---\nname: hallpass\ndescription: (.+)\n---\n/u.exec(AGENT_SKILL_TEXT);
    expect(front).not.toBeNull();
    expect(front![1]!.length).toBeGreaterThan(40);
    expect(front![1]!.length).toBeLessThanOrEqual(1024);
  });

  it("FR-413, FR-414: pairing, the three site modes, reads never ask, and a declined or timed-out card is not repeated", () => {
    for (const phrase of ["pairing card", "`ask`", "`follow-a-plan`", "`skip-checks`", "Reading never asks", "propose_sites"]) {
      expect(AGENT_SKILL_TEXT, phrase).toContain(phrase);
    }
    expect(AGENT_SKILL_TEXT).toMatch(/Declined card.*Do not send the same step again/su);
    expect(AGENT_SKILL_TEXT).toMatch(/Card timed out.*only if the user\s+asks/su);
  });

  it("FR-415: never asks the agent to get around a card or to change a site's mode", () => {
    expect(AGENT_SKILL_TEXT).toMatch(/Never try to get around a card/u);
    expect(AGENT_SKILL_TEXT).toMatch(/Never ask the user to\s+switch a site to `skip-checks`/u);
  });

  it("FR-424: English, short, with no local path or environment variable", () => {
    expect(AGENT_SKILL_TEXT).toMatch(/^[\x09\x0a\x20-\x7e]*$/u);
    expect(AGENT_SKILL_TEXT.split("\n").length).toBeLessThan(120);
    expect(AGENT_SKILL_TEXT).not.toMatch(/[A-Za-z]:\\|%[A-Z_]+%|\/Users\/|\/home\//u);
  });
});
