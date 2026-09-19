import type { ActionPoint, ActionTargetFacts } from "./action-label.js";

/**
 * The two things a recorded label needs and the dispatch point does not have (008/T221, FR-105,
 * FR-106).
 *
 * `dispatchTool` sees a tool name, its arguments and its answer. It does not see where the effect
 * landed - the runner measured that, from the element's own box - and it does not see what kind of
 * field the target was, which only a read of the page can say. Both are left here by the code that
 * did know, and picked up by the decorator a moment later.
 *
 * Deliberately a *hint* and never a source of truth: everything here is discarded freely, and a
 * label with no point simply draws no ring rather than drawing one somewhere plausible. Both stores
 * are bounded - a page of ten thousand controls read a hundred times must not become this worker's
 * memory profile - and both are dropped with the tab, because a ref means nothing without the
 * document that minted it.
 */

/** How many of a tab's refs are remembered; a working page's controls, not its whole tree. */
export const ACTION_FACTS_PER_TAB = 500;

/** How many deliveries are kept waiting for their decorator; a batch's steps are answered one at a time. */
export const ACTION_DELIVERIES_KEPT = 20;

/** What a runner measured about the effect it just delivered, in page CSS pixels. */
export type ActionDelivery = { point?: ActionPoint; from?: ActionPoint; to?: ActionPoint };

/** A node as a read reports it; only the members a label cares about. */
export type ReadNodeFacts = {
  ref?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  type?: string | undefined;
  redacted?: boolean | undefined;
};

export type ActionContext = {
  /** A read answered: what it said about each ref is what a later label may use. */
  noteNodes(tabId: number, nodes: readonly ReadNodeFacts[]): void;
  /** A runner delivered an effect and knows where; the decorator collects it by call id. */
  noteDelivery(callId: string, delivery: ActionDelivery): void;
  factsFor(tabId: number, ref: string | undefined): ActionTargetFacts | undefined;
  takeDelivery(callId: string): ActionDelivery | undefined;
  /** The lease is over: the refs die with the document they name elements of. */
  forget(tabId: number): void;
};

export function createActionContext(): ActionContext {
  const facts = new Map<number, Map<string, ActionTargetFacts>>();
  const deliveries = new Map<string, ActionDelivery>();
  return {
    noteNodes(tabId, nodes) {
      const known = facts.get(tabId) ?? new Map<string, ActionTargetFacts>();
      facts.set(tabId, known);
      for (const node of nodes) {
        if (typeof node.ref !== "string") continue;
        // Re-inserted rather than updated in place, so the eviction below is oldest-first by *use*.
        known.delete(node.ref);
        known.set(node.ref, {
          ...(node.name === undefined ? {} : { name: node.name }),
          ...(node.role === undefined ? {} : { role: node.role }),
          ...(node.type === undefined ? {} : { type: node.type }),
          ...(node.redacted === undefined ? {} : { redacted: node.redacted }),
        });
      }
      while (known.size > ACTION_FACTS_PER_TAB) {
        const oldest = known.keys().next();
        if (oldest.done) break;
        known.delete(oldest.value);
      }
    },
    noteDelivery(callId, delivery) {
      deliveries.set(callId, delivery);
      while (deliveries.size > ACTION_DELIVERIES_KEPT) {
        const oldest = deliveries.keys().next();
        if (oldest.done) break;
        deliveries.delete(oldest.value);
      }
    },
    factsFor(tabId, ref) {
      if (ref === undefined) return undefined;
      return facts.get(tabId)?.get(ref);
    },
    takeDelivery(callId) {
      const delivery = deliveries.get(callId);
      // Taken rather than read: one delivery belongs to one answer, and a stale one left behind
      // would put the previous action's ring on this action's frame.
      deliveries.delete(callId);
      return delivery;
    },
    forget(tabId) {
      facts.delete(tabId);
    },
  };
}
