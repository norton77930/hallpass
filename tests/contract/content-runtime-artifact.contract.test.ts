import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

const artifacts = ["apps/extension/dist/agent/content-runtime.js"] as const;

describe("T121 packaged content runtime artifact", () => {
  for (const artifact of artifacts) {
    it(artifact + " is one self-contained classic script", () => {
      const source = readFileSync(artifact, "utf8");
      expect(() => new Script(source, { filename: artifact })).not.toThrow();
      expect(source).not.toMatch(/\b(?:import|export)\s*(?:\{|\*|["'])/u);
      expect(source).not.toMatch(/["']\.\/chunks\//u);
    });
  }
});
