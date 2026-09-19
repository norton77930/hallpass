import { describe, expect, it } from "vitest";
import { discloseFormValue, type FormControlSnapshot } from "@hallpass/domain";

function item(control: FormControlSnapshot, grant: boolean) {
  return discloseFormValue(control, grant);
}

describe("T045 page collector Option C", () => {
  it("returns zero form values without a form grant", () => {
    const disclosed = item({ kind: "input", type: "text", name: "nickname", value: "Ada" }, false);
    expect(disclosed.value).toBeUndefined();
    expect(disclosed.classification).toBe("allowed-ordinary");
  });

  it("returns ordinary input/textarea/select state with a form grant", () => {
    expect(item({ kind: "input", type: "text", name: "nickname", value: "Ada" }, true).value).toBe("Ada");
    expect(item({ kind: "textarea", name: "notes", value: "Hello" }, true).value).toBe("Hello");
    expect(item({ kind: "select", name: "country", selectedOptionLabels: ["TW"] }, true).selectedOptionLabels).toEqual(["TW"]);
  });

  it("fails closed for compound autocomplete and credential-like or unidentified text controls", () => {
    const compoundCard = item(
      {
        kind: "input",
        type: "text",
        name: "checkout",
        autocomplete: "section-checkout shipping cc-number",
        value: "4111111111111111",
      },
      true,
    );
    const username = item({ kind: "input", type: "text", name: "username", value: "ada@example.test" }, true);
    const apiKey = item({ kind: "textarea", name: "api_key", value: "sk-private" }, true);
    const unidentified = item({ kind: "input", type: "text", value: "maybe-sensitive" }, true);
    for (const withheld of [compoundCard, username, apiKey, unidentified]) {
      expect(withheld.classification).not.toBe("allowed-ordinary");
      expect(withheld).not.toHaveProperty("value");
    }
    expect(JSON.stringify([compoundCard, username, apiKey, unidentified])).not.toMatch(
      /411111|ada@example|sk-private|maybe-sensitive/,
    );
  });

  it("withholds sensitive and ambiguous values including length and partial content", () => {
    const password = item({ kind: "input", type: "password", value: "s3cret" }, true);
    const otp = item({ kind: "input", type: "text", autocomplete: "one-time-code", value: "123456" }, true);
    const payment = item({ kind: "input", type: "text", autocomplete: "cc-number", value: "4111111111111111" }, true);
    const hidden = item({ kind: "input", type: "hidden", value: "token" }, true);
    const file = item({ kind: "input", type: "file", value: "id.png" }, true);
    const ambiguous = item({ kind: "checkbox", value: "on" }, true);
    for (const withheld of [password, otp, payment, hidden, file, ambiguous]) {
      expect(withheld).not.toHaveProperty("value");
      expect(JSON.stringify(withheld)).not.toMatch(/s3cret|123456|4111|token|id\.png/);
    }
  });
});
