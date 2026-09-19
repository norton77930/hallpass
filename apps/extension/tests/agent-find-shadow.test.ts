/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { findOnTab } from "../src/service-worker/agent-tools/refs.js";
import type { AgentPageBinding } from "../src/service-worker/agent-tools/page-binding.js";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";

/**
 * 004/T137 - `find` must see an open shadow root's control on its own, with no `read_page` run
 * first (FR-068, B87/B91).
 *
 * The seam this proves is `resolveInFrame`'s own collection in `refs.ts`: it mints handles under
 * `DEFAULT_BOUNDS.maxSemanticNodes` (200) because it passes no `bounds` at all, while `read_page`
 * asks for the page's own ceiling (`AGENT_READ_PAGE_MAX_NODES`, 10,000). `walkElements` appends an
 * open shadow root's content *after* every light-DOM match (`collector.ts`), so on a page with 200
 * or more ordinary elements ahead of it, the shadow control never reaches the registry `find`'s own
 * collection mints from - until a prior full read has already minted it. This fixture repeats that
 * shape free of any real site: 220 `<li>` decoys, then one button inside an open shadow root.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/shadow-heavy`;
const DOCUMENT_EPOCH = "doc-shadow-1";

function installChrome(): void {
  const runtimeContext = createContentRuntimeContext({ documentEpoch: DOCUMENT_EPOCH, canonicalOrigin: SITE });
  (globalThis as { chrome?: unknown }).chrome = {
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      // Bridges straight to the real content runtime against this document, so the walk order and
      // the registry it mints into are the production ones - not a fake answering by hand.
      async sendMessage(_tabId: number, message: unknown) {
        return handleContentMessage(message, undefined, runtimeContext);
      },
    },
  };
}

describe("T137 find sees an open shadow root's control on the first find", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("resolves a shadow-only control past 220 ordinary decoys, with no prior read", async () => {
    for (let index = 0; index < 220; index += 1) {
      const decoy = document.createElement("li");
      decoy.textContent = `decoy ${index}`;
      document.body.append(decoy);
    }
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow Only Button</button>";

    installChrome();
    const context = testSessionContexts().forCall("session-1", "call-1");
    const binding: AgentPageBinding = {
      tabId: AGENT_TAB,
      documentEpoch: DOCUMENT_EPOCH,
      canonicalOrigin: SITE,
      site: SITE,
    };

    const result = await findOnTab(context, binding, "Shadow Only Button", 3, async () => []);

    expect(result.ok).toBe(true);
    expect(result.ok && result.result.outcome).toBe("resolved");
  });
});
