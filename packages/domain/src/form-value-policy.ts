export type FormClassification = "allowed-ordinary" | "withheld-sensitive" | "withheld-ambiguous";

export type FormControlSnapshot = {
  kind: "input" | "textarea" | "select" | "checkbox" | "radio" | "other";
  type?: string;
  name?: string;
  autocomplete?: string;
  inputMode?: string;
  value?: string;
  selectedOptionLabels?: string[];
};

const SENSITIVE_TYPES = new Set(["password", "hidden", "file"]);
const SENSITIVE_AUTOCOMPLETE = new Set([
  "username",
  "email",
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
]);

const ORDINARY_NAMES = new Set([
  "nickname",
  "display-name",
  "query",
  "search",
  "website",
  "homepage",
  "message",
  "notes",
  "description",
  "country",
  "language",
  "locale",
  "timezone",
]);

const SENSITIVE_NAME_PART =
  /(?:^|[-_])(api[-_]?key|auth|card|credential|cvv|cvc|email|iban|national[-_]?id|otp|passcode|password|pin|routing|secret|social[-_]?security|ssn|tax[-_]?id|token|username)(?:$|[-_])/;

export function classifyFormControl(control: FormControlSnapshot): FormClassification {
  const type = (control.type ?? "").toLowerCase();
  const autocomplete = (control.autocomplete ?? "").toLowerCase();
  const name = (control.name ?? "").toLowerCase();
  const autocompleteTokens = autocomplete.split(/\s+/u).filter(Boolean);
  if (control.kind === "checkbox" || control.kind === "radio" || control.kind === "other") {
    return "withheld-ambiguous";
  }
  if (SENSITIVE_TYPES.has(type) || autocompleteTokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) {
    return "withheld-sensitive";
  }
  if (SENSITIVE_NAME_PART.test(name.replaceAll(" ", "-"))) {
    return "withheld-sensitive";
  }
  if (control.kind === "input" || control.kind === "textarea" || control.kind === "select") {
    if (!ORDINARY_NAMES.has(name)) {
      return "withheld-ambiguous";
    }
    if (control.kind === "input" && type && type !== "text" && type !== "search" && type !== "url") {
      return "withheld-ambiguous";
    }
    return "allowed-ordinary";
  }
  return "withheld-ambiguous";
}

export function discloseFormValue(
  control: FormControlSnapshot,
  formGrantActive: boolean,
): {
  classification: FormClassification;
  value?: string;
  selectedOptionLabels?: string[];
} {
  const classification = classifyFormControl(control);
  if (!formGrantActive || classification !== "allowed-ordinary") {
    return { classification };
  }
  if (control.kind === "select") {
    return {
      classification,
      ...(control.selectedOptionLabels !== undefined
        ? { selectedOptionLabels: control.selectedOptionLabels }
        : {}),
    };
  }
  return {
    classification,
    ...(control.value !== undefined ? { value: control.value } : {}),
  };
}
