import { describe, expect, it } from "vitest";
import { displayOrigin } from "../src/side-panel/agent/display-origin.js";

/**
 * 017 follow-up: IDN origins shown as punycode.
 *
 * An origin with an `xn--` label is shown as the Unicode host followed by the ASCII host, so the owner
 * can read it and a look-alike still shows its real letters. Anything else, or anything that does not
 * decode, is shown exactly as given.
 */
describe("displayOrigin", () => {
  it("decodes the RFC 3492 sample labels and shows both forms", () => {
    expect(displayOrigin("https://xn--r8jz45g.jp")).toBe("https://例え.jp (xn--r8jz45g.jp)");
    expect(displayOrigin("https://xn--mnchen-3ya.de")).toBe("https://münchen.de (xn--mnchen-3ya.de)");
    // RFC 3492 §7.1 (B), Chinese (simplified).
    expect(displayOrigin("https://xn--ihqwcrb4cv8a8dqg056pqjye.test")).toBe(
      "https://他们为什么不说中文.test (xn--ihqwcrb4cv8a8dqg056pqjye.test)",
    );
    // RFC 3492 §7.1 (A), Arabic (Egyptian).
    expect(displayOrigin("https://xn--egbpdaj6bu4bxfgehfvwxn.test")).toBe(
      "https://ليهمابتكلموشعربي؟.test (xn--egbpdaj6bu4bxfgehfvwxn.test)",
    );
  });

  it("leaves a plain ASCII origin exactly as it is", () => {
    expect(displayOrigin("https://shop.test")).toBe("https://shop.test");
    expect(displayOrigin("https://docs.test:8443")).toBe("https://docs.test:8443");
    expect(displayOrigin("http://localhost:19443")).toBe("http://localhost:19443");
  });

  it("keeps the scheme and the port", () => {
    expect(displayOrigin("https://xn--r8jz45g.jp:8443")).toBe("https://例え.jp:8443 (xn--r8jz45g.jp)");
    expect(displayOrigin("http://xn--r8jz45g.jp")).toBe("http://例え.jp (xn--r8jz45g.jp)");
  });

  it("decodes only the xn-- labels of a mixed host", () => {
    expect(displayOrigin("https://xn--mnchen-3ya.example.com")).toBe(
      "https://münchen.example.com (xn--mnchen-3ya.example.com)",
    );
    expect(displayOrigin("https://shop.xn--r8jz45g.jp")).toBe("https://shop.例え.jp (shop.xn--r8jz45g.jp)");
  });

  it("returns the raw origin when any label fails to decode", () => {
    // Decodes to plain ASCII: not a valid A-label.
    expect(displayOrigin("https://xn--zz--.test")).toBe("https://xn--zz--.test");
    // Overflow of the 32-bit accumulator.
    expect(displayOrigin("https://xn--a-99999999999999999.test")).toBe("https://xn--a-99999999999999999.test");
    // Truncated variable-length integer.
    expect(displayOrigin("https://xn--a-9.test")).toBe("https://xn--a-9.test");
    // Not a base-36 digit.
    expect(displayOrigin("https://xn--a-_.test")).toBe("https://xn--a-_.test");
    // Empty after the prefix.
    expect(displayOrigin("https://xn--.test")).toBe("https://xn--.test");
    // One good label does not rescue a bad one.
    expect(displayOrigin("https://xn--r8jz45g.xn--a-9.jp")).toBe("https://xn--r8jz45g.xn--a-9.jp");
  });

  it("returns the raw origin when a label decodes to controls, format characters or spaces", () => {
    // U+0085 U+0086 (C1 controls).
    expect(displayOrigin("https://xn--fac.test")).toBe("https://xn--fac.test");
    // "a", U+202E (right-to-left override), "b", "é".
    expect(displayOrigin("https://xn--ab-cja2313a.test")).toBe("https://xn--ab-cja2313a.test");
    // "例", U+3000 (ideographic space), "え".
    expect(displayOrigin("https://xn--p6jzh963g.jp")).toBe("https://xn--p6jzh963g.jp");
    // "例", U+200B (zero-width space), "え".
    expect(displayOrigin("https://xn--zug715d6sx.jp")).toBe("https://xn--zug715d6sx.jp");
  });

  it("decodes upper-case labels and digits, and keeps a trailing dot", () => {
    expect(displayOrigin("https://XN--R8JZ45G.JP")).toBe("https://例え.JP (XN--R8JZ45G.JP)");
    expect(displayOrigin("https://xn--r8jz45g.jp.")).toBe("https://例え.jp. (xn--r8jz45g.jp.)");
  });

  it("returns the raw origin for a non-ASCII basic part or a lone leading delimiter", () => {
    expect(displayOrigin("https://xn--é-abc.test")).toBe("https://xn--é-abc.test");
    expect(displayOrigin("https://xn---x.test")).toBe("https://xn---x.test");
  });

  it("returns user-info shaped input unchanged", () => {
    expect(displayOrigin("https://xn--r8jz45g.jp@evil.test")).toBe("https://xn--r8jz45g.jp@evil.test");
    expect(displayOrigin("https://user@xn--r8jz45g.jp")).toBe("https://user@xn--r8jz45g.jp");
  });

  it("returns anything that is not an origin unchanged", () => {
    for (const input of ["", "xn--r8jz45g.jp", "not an origin", "https://xn--r8jz45g.jp/path", "https://[::1]:8080"]) {
      expect(displayOrigin(input)).toBe(input);
    }
  });
});
