import { RUNTIME_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.js";
import { expect, test } from "../fixtures/packaged-extension.js";
import { DEFAULT_BOUNDS } from "@hallpass/contracts";

const TEST_NONCE = "0".repeat(32);
const TEST_COLLECTION_BOUNDS = {
  maxVisibleTextChars: DEFAULT_BOUNDS.maxVisibleTextChars,
  maxSemanticNodes: DEFAULT_BOUNDS.maxSemanticNodes,
  maxLabelChars: DEFAULT_BOUNDS.maxLabelChars,
};

/**
 * WP4 (review H4) and WP8 claim 9: the packaged content runtime applies the closed form-value policy
 * twice over. At collection it offers a handle only for a control the policy would accept, so every
 * sensitive control on the `/form` fixture — and the unnamed text control the policy cannot name —
 * receives no handle at all. At the effect it re-reads the live element, so a control that was
 * ordinary when its handle was minted and turned into a payment field afterwards is still refused.
 * This drives the real built classic-script runtime in the real page; nothing here imports a private
 * module.
 */
function frame(input: {
  type: "content.probe" | "content.collect-page" | "content.execute-action";
  operationId: string;
  documentEpoch: string;
  payload: Record<string, unknown>;
}) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    runtimeEpochId: "epoch-packaged-sensitive-entry",
    type: input.type,
    taskId: "task-packaged-sensitive-entry",
    operationId: input.operationId,
    nonce: TEST_NONCE,
    expectedTabId: 1,
    expectedDocumentEpoch: input.documentEpoch,
    payload: input.payload,
  };
}

/** Every control on the `/form` fixture the closed policy will never call ordinary. */
const NEVER_ORDINARY = ["password", "csrf", "attachment", "otp", "card", "cvc", "api-key"];

test("packaged content runtime offers no handle for a control it would refuse, and refuses one that turned sensitive", async ({
  extensionContext,
  extensionWorker,
}) => {
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await page.goto("https://localhost:19443/form");
  await page.bringToFront();
  const unnamedInput = page.locator('input[type="text"]:not([name])');
  const unnamedBefore = await unnamedInput.inputValue();

  const collected = await extensionWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
      documentEpoch: string;
    };
    const result = (await chrome.tabs.sendMessage(
      tab.id,
      { ...input.collect, expectedDocumentEpoch: probe.documentEpoch },
      { frameId: 0 },
    )) as { semanticNodes?: Array<{ role?: string; label?: string; targetHandle?: string }> };
    const nodes = result.semanticNodes ?? [];
    const handleFor = (label: string) =>
      nodes.find((node) => node.label === label)?.targetHandle;
    return {
      documentEpoch: probe.documentEpoch,
      offeredSensitive: nodes
        .filter((node) => node.targetHandle && node.label && input.neverOrdinary.includes(node.label))
        .map((node) => node.label),
      offeredUnnamed: nodes.some((node) => node.role === "textbox" && !node.label && node.targetHandle),
      nickname: handleFor("nickname"),
      message: handleFor("message"),
      nodes,
    };
  }, {
    neverOrdinary: NEVER_ORDINARY,
    probe: frame({ type: "content.probe", operationId: "op-sensitive-probe", documentEpoch: "probe-unbound", payload: {} }),
    collect: frame({
      type: "content.collect-page",
      operationId: "op-sensitive-collect",
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-packaged-read",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.target-metadata"],
      },
    }),
  });

  // A handle is an offer to act. Nothing the policy would refuse at the effect is ever offered one.
  expect(collected.offeredSensitive).toEqual([]);
  expect(collected.offeredUnnamed).toBe(false);
  // The two allow-listed controls on the same document are offered, so the filter removes only what
  // would be refused rather than emptying the page.
  expect(collected.nickname, JSON.stringify(collected.nodes)).toBeTruthy();
  expect(collected.message, JSON.stringify(collected.nodes)).toBeTruthy();

  // The page turns the ordinary field into a payment field after its handle was minted.
  await page.locator('input[name="nickname"]').evaluate((element) => {
    element.setAttribute("autocomplete", "cc-number");
  });

  const effects = await extensionWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");
    const refused = await chrome.tabs.sendMessage(
      tab.id,
      {
        ...input.refuse,
        payload: {
          action: "browser.enter-text",
          arguments: { targetHandle: input.mutated, text: "4111111111111111", editMode: "replace" },
        },
      },
      { frameId: 0 },
    );
    const accepted = await chrome.tabs.sendMessage(
      tab.id,
      {
        ...input.accept,
        payload: {
          action: "browser.enter-text",
          arguments: { targetHandle: input.ordinary, text: "typed by the assistant", editMode: "replace" },
        },
      },
      { frameId: 0 },
    );
    return { refused, accepted };
  }, {
    mutated: String(collected.nickname),
    ordinary: String(collected.message),
    refuse: frame({
      type: "content.execute-action",
      operationId: "op-sensitive-refuse",
      documentEpoch: collected.documentEpoch,
      payload: { action: "browser.enter-text", arguments: {} },
    }),
    accept: frame({
      type: "content.execute-action",
      operationId: "op-sensitive-accept",
      documentEpoch: collected.documentEpoch,
      payload: { action: "browser.enter-text", arguments: {} },
    }),
  });

  // The effect-time gate re-reads the live element, so the handle it already holds does not help.
  expect(effects.refused).toMatchObject({ ok: false, reason: "denied" });
  expect(effects.accepted).toMatchObject({
    ok: true,
    effect: "text-entered",
    documentChanged: false,
    valueEchoed: false,
  });

  await expect(unnamedInput).toHaveValue(unnamedBefore);
  await expect(page.locator('input[name="nickname"]')).not.toHaveValue("4111111111111111");
  await expect(page.locator('textarea[name="message"]')).toHaveValue("typed by the assistant");
  for (const name of NEVER_ORDINARY) {
    const control = page.locator(`[name="${name}"]`);
    if ((await control.count()) > 0) {
      await expect(control.first()).not.toHaveValue("4111111111111111");
    }
  }
});
