import { RUNTIME_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.js";
import { TEST_EXTENSION_ID } from "../../../packages/test-kit/src/build-config.js";
import { expect, test } from "../fixtures/packaged-extension.js";
import { resolve } from "node:path";
import { DEFAULT_BOUNDS } from "@hallpass/contracts";

const TEST_NONCE = "0".repeat(32);
const TEST_COLLECTION_BOUNDS = {
  maxVisibleTextChars: DEFAULT_BOUNDS.maxVisibleTextChars,
  maxSemanticNodes: DEFAULT_BOUNDS.maxSemanticNodes,
  maxLabelChars: DEFAULT_BOUNDS.maxLabelChars,
};

function frame(input: {
  type: "content.probe" | "content.collect-page" | "content.execute-action";
  taskId: string;
  operationId: string;
  epoch: string;
  tabId: number;
  documentEpoch: string;
  payload: Record<string, unknown>;
}) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    runtimeEpochId: input.epoch,
    type: input.type,
    taskId: input.taskId,
    operationId: input.operationId,
    nonce: TEST_NONCE,
    expectedTabId: input.tabId,
    expectedDocumentEpoch: input.documentEpoch,
    payload: input.payload,
  };
}

test("packaged MV3 worker injects, probes, collects, and reinjects the built classic runtime", async ({
  extensionContext,
  extensionId,
  extensionWorker,
}) => {
  expect(extensionId).toBe(TEST_EXTENSION_ID);
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await page.goto("https://localhost:19443/ordinary");
  await page.bringToFront();
  await expect(page.getByRole("heading", { name: "Ordinary page" })).toBeVisible();

  const result = await extensionWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");

    let initialProbe = "unexpected-success";
    try {
      await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 });
    } catch (error) {
      initialProbe = error instanceof Error ? error.message : String(error);
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
      documentEpoch: string;
      canonicalOrigin: string;
    };
    const collect = {
      ...input.collect,
      expectedDocumentEpoch: probe.documentEpoch,
    };
    const collected = await chrome.tabs.sendMessage(tab.id, collect, { frameId: 0 });

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    const reinjectedProbe = await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 });
    return { initialProbe, probe, collected, reinjectedProbe };
  }, {
    probe: frame({
      type: "content.probe",
      taskId: "task-packaged-read",
      operationId: "op-packaged-probe",
      epoch: "epoch-packaged-runtime",
      tabId: 1,
      documentEpoch: "probe-unbound",
      payload: {},
    }),
    collect: frame({
      type: "content.collect-page",
      taskId: "task-packaged-read",
      operationId: "op-packaged-collect",
      epoch: "epoch-packaged-runtime",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-packaged-read",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.title", "page.structure"],
      },
    }),
  });

  expect(result.initialProbe).toMatch(/receiving end does not exist|could not establish connection/i);
  expect(result.probe.canonicalOrigin).toBe("https://localhost:19443");
  expect(result.collected).toMatchObject({
    canonicalOrigin: "https://localhost:19443",
    title: "Ordinary fixture",
  });
  expect((result.collected as { visibleText?: string }).visibleText).toContain("Ordinary page");
  expect(result.reinjectedProbe).toMatchObject({
    canonicalOrigin: "https://localhost:19443",
  });
});

test("packaged content runtime executes a collected button target in the real page", async ({
  extensionContext,
  extensionWorker,
}) => {
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await page.goto("https://localhost:19443/ordinary");
  await page.bringToFront();
  await expect(page.locator("#clicked")).toHaveText("not clicked yet");
  await page.evaluate(() => {
    const pageGlobal = globalThis as typeof globalThis & { __packagedClickCount?: number };
    pageGlobal.__packagedClickCount = 0;
    document.querySelector("#safe-button")?.addEventListener("click", () => {
      pageGlobal.__packagedClickCount = (pageGlobal.__packagedClickCount ?? 0) + 1;
    });
  });

  const result = await extensionWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
      documentEpoch: string;
    };
    const collected = (await chrome.tabs.sendMessage(
      tab.id,
      { ...input.collect, expectedDocumentEpoch: probe.documentEpoch },
      { frameId: 0 },
    )) as { semanticNodes?: Array<{ label?: string; targetHandle?: string }> };
    const targetHandle = collected.semanticNodes?.find((node) => node.label === "Safe action")?.targetHandle;
    if (!targetHandle) throw new Error("safe-action-target-missing");
    return chrome.tabs.sendMessage(
      tab.id,
      {
        ...input.execute,
        expectedDocumentEpoch: probe.documentEpoch,
        payload: { action: "browser.click", arguments: { targetHandle } },
      },
      { frameId: 0 },
    );
  }, {
    probe: frame({
      type: "content.probe",
      taskId: "task-packaged-click",
      operationId: "op-packaged-probe",
      epoch: "epoch-packaged-click",
      tabId: 1,
      documentEpoch: "probe-unbound",
      payload: {},
    }),
    collect: frame({
      type: "content.collect-page",
      taskId: "task-packaged-click",
      operationId: "op-packaged-collect",
      epoch: "epoch-packaged-click",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-packaged-read",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.target-metadata"],
      },
    }),
    execute: frame({
      type: "content.execute-action",
      taskId: "task-packaged-click",
      operationId: "op-packaged-click",
      epoch: "epoch-packaged-click",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: { action: "browser.click", arguments: {} },
    }),
  });

  expect(result).toMatchObject({ ok: true, effect: "activated", clicks: 1 });
  await expect(page.locator("#clicked")).toContainText("clicked at");
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __packagedClickCount?: number }).__packagedClickCount,
    ),
  ).toBe(1);
});

test("packaged content runtime rejects each opaque-only fixture without returning page data", async ({
  extensionContext,
  extensionWorker,
}) => {
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  for (const fixture of ["iframe-only", "shadow-dom-only", "canvas-only"] as const) {
    await page.goto(`https://localhost:19443/${fixture}`);
    await page.bringToFront();
    const result = await extensionWorker.evaluate(async (input) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("missing-active-tab");
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
      const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
        documentEpoch: string;
      };
      return chrome.tabs.sendMessage(
        tab.id,
        { ...input.collect, expectedDocumentEpoch: probe.documentEpoch },
        { frameId: 0 },
      );
    }, {
      probe: frame({
        type: "content.probe",
        taskId: `task-opaque-${fixture}`,
        operationId: `op-probe-${fixture}`,
        epoch: "epoch-opaque-runtime",
        tabId: 1,
        documentEpoch: "probe-unbound",
        payload: {},
      }),
      collect: frame({
        type: "content.collect-page",
        taskId: `task-opaque-${fixture}`,
        operationId: `op-collect-${fixture}`,
        epoch: "epoch-opaque-runtime",
        tabId: 1,
        documentEpoch: "replaced-after-probe",
        payload: {
          generalPageReadGrantId: "grant-opaque-read",
          bounds: TEST_COLLECTION_BOUNDS,
          requestedDataCategories: ["page.visible-text", "page.title", "page.structure"],
        },
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: "unsupported-page",
      formValueItems: [],
    }));
    expect(result).not.toHaveProperty("visibleText");
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("semanticNodes");
  }
});

test("packaged form collection requires the separate grant and withholds every sensitive sentinel", async ({
  extensionContext,
  extensionWorker,
}) => {
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await page.goto("https://localhost:19443/form");
  await page.bringToFront();
  const result = await extensionWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
      documentEpoch: string;
    };
    const withoutGrant = await chrome.tabs.sendMessage(
      tab.id,
      { ...input.withoutGrant, expectedDocumentEpoch: probe.documentEpoch },
      { frameId: 0 },
    );
    const withGrant = await chrome.tabs.sendMessage(
      tab.id,
      { ...input.withGrant, expectedDocumentEpoch: probe.documentEpoch },
      { frameId: 0 },
    );
    return { withoutGrant, withGrant };
  }, {
    probe: frame({
      type: "content.probe",
      taskId: "task-packaged-form",
      operationId: "op-form-probe",
      epoch: "epoch-packaged-form",
      tabId: 1,
      documentEpoch: "probe-unbound",
      payload: {},
    }),
    withoutGrant: frame({
      type: "content.collect-page",
      taskId: "task-packaged-form",
      operationId: "op-form-general",
      epoch: "epoch-packaged-form",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-packaged-general",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text"],
      },
    }),
    withGrant: frame({
      type: "content.collect-page",
      taskId: "task-packaged-form",
      operationId: "op-form-values",
      epoch: "epoch-packaged-form",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-packaged-general",
        bounds: TEST_COLLECTION_BOUNDS,
        formValuesGrantId: "grant-packaged-form",
        requestedDataCategories: ["page.visible-text", "page.form-values"],
      },
    }),
  }) as {
    withoutGrant: { visibleText?: string; formValueItems?: unknown[] };
    withGrant: { visibleText?: string; formValueItems?: Array<Record<string, unknown>> };
  };

  expect(result.withoutGrant.formValueItems).toEqual([]);
  expect(result.withoutGrant.visibleText).not.toMatch(/ordinary-nickname|ordinary comment|SENTINEL-/);
  const allowed = result.withGrant.formValueItems?.filter((item) => item.classification === "allowed-ordinary") ?? [];
  expect(allowed).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: "ordinary-nickname" }),
    expect.objectContaining({ value: "ordinary comment text" }),
    expect.objectContaining({ selectedOptionLabels: ["Green"] }),
  ]));
  const serialized = JSON.stringify(result.withGrant);
  expect(serialized).not.toMatch(/SENTINEL-|PASSWORD|HIDDEN|ONETIMECODE|CARDNUMBER|CVC|PRODUCTCRED|AMBIGUOUS/);
  expect(result.withGrant.formValueItems?.some((item) => item.classification === "withheld-sensitive")).toBe(true);
  expect(result.withGrant.formValueItems?.some((item) => item.classification === "withheld-ambiguous")).toBe(true);
});

test("extension reload can reinject an existing page through a new MV3 worker", async ({
  extensionContext,
  extensionId,
  extensionWorker,
}) => {
  // `Extensions.loadUnpacked` is the command-line sideload path a branded Chrome refuses; on a
  // browser the gate merely attached to, the reload cannot be driven, so this case is reported as
  // skipped rather than as evidence. The reload behaviour itself stays covered by the launched gate.
  test.skip(
    process.env.HALLPASS_CDP_ENDPOINT !== undefined,
    "extension reload over CDP needs a browser this gate launched itself",
  );
  const page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await page.goto("https://localhost:19443/ordinary");
  await page.bringToFront();

  await extensionWorker.evaluate(async (probe) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    await chrome.tabs.sendMessage(tab.id, probe, { frameId: 0 });
  }, frame({
    type: "content.probe",
    taskId: "task-before-reload",
    operationId: "op-before-reload",
    epoch: "epoch-before-reload",
    tabId: 1,
    documentEpoch: "probe-unbound",
    payload: {},
  }));

  const browser = extensionContext.browser();
  if (!browser) throw new Error("persistent-browser-missing");
  const browserSession = await browser.newBrowserCDPSession();
  const nextWorker = extensionContext.waitForEvent("serviceworker", {
    predicate: (worker) => worker !== extensionWorker,
    timeout: 15_000,
  });
  const workerClosed = extensionWorker.waitForEvent("close");
  const reloaded = await browserSession.send("Extensions.loadUnpacked", {
    path: resolve("apps/extension/dist/agent"),
  });
  expect(reloaded.id).toBe(extensionId);
  await workerClosed;

  const reloadedWorker = await nextWorker;
  await page.bringToFront();

  const collected = await reloadedWorker.evaluate(async (input) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("missing-active-tab-after-reload");
    try {
      await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-runtime.js"] });
    }
    const probe = (await chrome.tabs.sendMessage(tab.id, input.probe, { frameId: 0 })) as {
      documentEpoch: string;
    };
    return chrome.tabs.sendMessage(
      tab.id,
      { ...input.collect, expectedDocumentEpoch: probe.documentEpoch },
      { frameId: 0 },
    );
  }, {
    probe: frame({
      type: "content.probe",
      taskId: "task-after-reload",
      operationId: "op-after-reload-probe",
      epoch: "epoch-after-reload",
      tabId: 1,
      documentEpoch: "probe-unbound",
      payload: {},
    }),
    collect: frame({
      type: "content.collect-page",
      taskId: "task-after-reload",
      operationId: "op-after-reload-collect",
      epoch: "epoch-after-reload",
      tabId: 1,
      documentEpoch: "replaced-after-probe",
      payload: {
        generalPageReadGrantId: "grant-after-reload",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.title"],
      },
    }),
  });

  expect(collected).toMatchObject({
    canonicalOrigin: "https://localhost:19443",
    title: "Ordinary fixture",
  });
  expect((collected as { visibleText?: string }).visibleText).toContain("Ordinary page");
});
