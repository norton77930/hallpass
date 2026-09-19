import { mintTargetHandle } from "./targets.js";

/**
 * The document's own register of the elements it has named (004/US6, R-115, FR-066).
 *
 * 003 minted a fresh handle for every element on every collection and threw the previous ones away,
 * which made a reference a fact about the *read* rather than about the element: an agent that read
 * twice could not act on what the first read told it. This register is the other half of that
 * decision. An element is entered once, keeps its entry for as long as it is part of the document,
 * and loses it when it is not - so "stale" means the element is gone, and nothing else.
 *
 * Three rules make that a safe promise rather than a convenient one:
 *
 * - **An index is never recycled.** The counter only goes up, and a retired index is retired for
 *   the life of the document. Reusing one would hand a caller *someone else's* element under the
 *   name it already holds, which is worse than telling it the name is stale.
 * - **Elements are held weakly.** Both directions - index to element and element to index - hold
 *   the node weakly, so a page that removes an element is never kept from collecting it because
 *   this register still remembers what it was called.
 * - **It dies with the document.** The register is per document by construction: nothing carries
 *   an entry across a navigation, so a name minted before one can never resolve after it.
 */

/** What the document knows an element by: its position in the register, and the page-side handle. */
export type RegistryEntry = { index: number; handle: string };

/** The parts of a DOM node this register reads. Structural so a fake DOM can be entered too. */
type RegisterableElement = { isConnected?: unknown };

export class ElementRegistry {
  /** Only ever increases: see "never recycled" above. */
  private nextIndex = 1;
  private readonly byIndex = new Map<number, { ref: WeakRef<object>; handle: string }>();
  private readonly byHandle = new Map<string, number>();
  private readonly byElement = new WeakMap<object, number>();

  /**
   * The handle policy is injected so this file owns *lifetime* and nothing else: handles stay
   * unpredictable and unguessable because `mintTargetHandle` says so, not because of anything the
   * register does with an index.
   */
  constructor(private readonly mint: () => string = mintTargetHandle) {}

  /** This element's entry, making one the first time the document names it. */
  register(node: unknown): RegistryEntry {
    const element = node as object;
    const known = this.byElement.get(element);
    if (known !== undefined) {
      const entry = this.byIndex.get(known);
      if (entry) return { index: known, handle: entry.handle };
    }
    const index = this.nextIndex;
    this.nextIndex += 1;
    const handle = this.mint();
    this.byIndex.set(index, { ref: new WeakRef(element), handle });
    this.byHandle.set(handle, index);
    this.byElement.set(element, index);
    return { index, handle };
  }

  /**
   * Binds a handle a caller minted elsewhere to an element (002's live registrations and the
   * capability tests). The element still gets exactly one index, so it still has one lifetime: the
   * extra handle is another name for that entry, never another entry.
   */
  bind(handle: string, node: unknown): RegistryEntry {
    const entry = this.register(node);
    if (!this.byHandle.has(handle)) this.byHandle.set(handle, entry.index);
    return entry;
  }

  /** The entry this element already has, or nothing - registering is the caller's decision. */
  entryOf(node: unknown): RegistryEntry | undefined {
    const index = this.byElement.get(node as object);
    if (index === undefined) return undefined;
    const entry = this.byIndex.get(index);
    return entry ? { index, handle: entry.handle } : undefined;
  }

  /** The entry a handle names, or nothing once that entry has been pruned. */
  entryOfHandle(handle: string): RegistryEntry | undefined {
    const index = this.byHandle.get(handle);
    if (index === undefined) return undefined;
    return this.byIndex.has(index) ? { index, handle } : undefined;
  }

  /** The element at an index, while the register still has an entry for it. */
  elementAt(index: number): unknown {
    return this.byIndex.get(index)?.ref.deref();
  }

  /**
   * The element a handle names, while the register still has an entry for it.
   *
   * A *disconnected* element is still answered until the next collection prunes it, deliberately:
   * "this element has left the page" is an answer some callers are waiting for (002/FR-048's
   * `absent`), and turning it into "this name means nothing" here would take that answer away.
   * Pruning is the one place an entry is retired.
   */
  elementOf(handle: string): unknown {
    const index = this.byHandle.get(handle);
    return index === undefined ? undefined : this.byIndex.get(index)?.ref.deref();
  }

  /**
   * Drops every entry whose element the document no longer holds. Called at the start of each
   * collection: pruning is what keeps the register a fact about the page rather than a growing
   * memory of it, and it is the only thing that ever removes an entry.
   */
  prune(): number {
    let dropped = 0;
    for (const [index, entry] of this.byIndex) {
      if (this.connected(entry.ref.deref()) !== undefined) continue;
      this.byIndex.delete(index);
      dropped += 1;
    }
    // Every name of a retired entry goes with it, not only the one the register minted itself.
    for (const [handle, index] of this.byHandle) {
      if (!this.byIndex.has(index)) this.byHandle.delete(handle);
    }
    return dropped;
  }

  /** How many elements the document currently has names for. */
  get size(): number {
    return this.byIndex.size;
  }

  /**
   * The holders themselves, so a test can prove the register's hold on page content is weak in
   * both directions. Nothing in the runtime reads this; the property it states is the reason the
   * register may outlive a read at all.
   */
  weakHolders(): { byIndex: ReadonlyMap<number, WeakRef<object>>; byElement: WeakMap<object, number> } {
    const byIndex = new Map<number, WeakRef<object>>();
    for (const [index, entry] of this.byIndex) byIndex.set(index, entry.ref);
    return { byIndex, byElement: this.byElement };
  }

  /**
   * An element the document still holds, or nothing. A node the collector was handed by a fake DOM
   * has no `isConnected` to state the opposite, so only an explicit `false` retires an entry.
   */
  private connected(element: unknown): unknown {
    if (element === undefined) return undefined;
    return (element as RegisterableElement).isConnected === false ? undefined : element;
  }
}
