import {
  injectIfSupported,
  probeActiveTab,
  resolveSupportedTabPage,
} from "../content-broker.js";
import { siteOfUrl } from "../site-mode-store.js";
import type { AgentToolContext } from "./context.js";

/**
 * What the shared runtime needs to know about a page before anything may act on it (003/T028).
 *
 * The remote path gets this from its lease: a task binds one tab, one origin and one document
 * epoch, and every frame repeats them. The agent has no lease, so the binding is established per
 * tab, on demand, and cached until something invalidates it.
 *
 * It is deliberately the *same* three facts. The epoch is what makes a handle stale when the
 * document is replaced, and the origin is what the site mode was decided about; a binding that
 * carried less would let an effect land on a page the owner never consented to.
 */

export type AgentPageBinding = {
  tabId: number;
  documentEpoch: string;
  canonicalOrigin: string;
  /** The site the owner's mode is keyed by; the same value `site-mode-store` uses. */
  site: string;
};

/** Why a tab could not be bound. Each maps to one tool outcome, decided by the caller. */
export type AgentBindingFailure =
  /** A page this extension may not act on at all: a restricted scheme, a PDF, the web store. */
  | { ok: false; reason: "not-actionable" }
  /** The tab is gone, or the runtime would not answer: nothing to act on and nothing observed. */
  | { ok: false; reason: "stale" };

export type AgentPageBindings = {
  bind(tabId: number, context: AgentToolContext): Promise<{ ok: true; binding: AgentPageBinding } | AgentBindingFailure>;
  /** Drops a tab's binding: a navigation or a replaced document makes every handle under it stale. */
  invalidate(tabId: number): void;
};

export function createAgentPageBindings(): AgentPageBindings {
  const cache = new Map<number, AgentPageBinding>();

  return {
    async bind(tabId, context) {
      const cached = cache.get(tabId);
      let page: Awaited<ReturnType<typeof resolveSupportedTabPage>>;
      try {
        page = await resolveSupportedTabPage(tabId);
      } catch (error) {
        // `unsupported-page` is a fact about the page; anything else is a tab that is not there.
        const message = error instanceof Error ? error.message : "";
        cache.delete(tabId);
        return { ok: false, reason: message === "unsupported-page" ? "not-actionable" : "stale" };
      }
      const site = siteOfUrl(page.supportInput.protocol + "//" + page.supportInput.hostname);
      if (cached && cached.canonicalOrigin !== page.canonicalOrigin) {
        // The tab navigated across origins. Everything bound to the old document - and the mode the
        // old site was decided under - belongs to a page that is no longer there.
        cache.delete(tabId);
      }
      const probeInput = {
        taskId: context.taskId,
        operationId: context.operationId,
        runtimeEpochId: context.runtimeEpochId,
        nonce: context.nonce,
        expectedTabId: tabId,
        canonicalOrigin: page.canonicalOrigin,
        tab: tabId,
      };
      /**
       * Probe first, inject only if nothing answers - the same order the remote path's own
       * `ensureContentRuntime` uses, and for a reason the agent path feels harder than 001/002 did.
       *
       * The target registry lives inside the injected module, so injecting again builds a *new*
       * empty one and every handle the page has minted stops naming anything. The agent's tools are
       * separate calls - `find` mints a ref, `click` uses it - so an injection between them turns a
       * perfectly intact page into `stale`. (This is exactly what T031 saw before this fix.)
       *
       * An MV3 worker torn down between two calls remembers nothing, which is why the question is
       * asked of the page rather than of a flag here: only the page knows whether it still has a
       * runtime.
       */
      let probed = await probeActiveTab(probeInput);
      if (!probed.ok && probed.reason === "document-replaced") {
        try {
          await injectIfSupported(tabId, page.supportInput);
        } catch {
          return { ok: false, reason: "not-actionable" };
        }
        probed = await probeActiveTab(probeInput);
      }
      if (!probed.ok) {
        cache.delete(tabId);
        return { ok: false, reason: probed.reason === "unsupported-page" ? "not-actionable" : "stale" };
      }
      const binding: AgentPageBinding = {
        tabId,
        documentEpoch: probed.documentEpoch,
        canonicalOrigin: probed.canonicalOrigin,
        // The probe's origin is the authority; the support input is only how the tab was classified.
        site: siteOfUrl(probed.canonicalOrigin) ?? site ?? probed.canonicalOrigin,
      };
      if (cached && cached.documentEpoch !== binding.documentEpoch) {
        // A new document under the same origin. The mode still applies; the handles do not.
        cache.delete(tabId);
      }
      cache.set(tabId, binding);
      return { ok: true, binding };
    },
    invalidate(tabId) {
      cache.delete(tabId);
    },
  };
}
