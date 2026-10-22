import { CONVERSATION_PAGE_MAX_BYTES, CONVERSATION_TEXT_MAX_CHARS, type ConversationEvent } from "@hallpass/contracts";

/**
 * One running conversation's event log, in broker memory only (019 R-318, D-019-6; T537, T539).
 *
 * It is what a panel document that (re)connects is served from, page by page, so the log is capped
 * at 256 KB per conversation. Size is counted the way a page is checked by the contract - the
 * length of the JSON of the entries - so `bytes` is exactly `JSON.stringify(entries).length`.
 *
 * Over the cap the oldest *text* gives way first: two adjacent text entries of the same speaker are
 * merged into the older one's `seq`, keeping the newer end of the words (a merged text longer than
 * one event may carry loses its oldest part, marked with a leading ellipsis). With no adjacent pair
 * left the oldest text entry goes, and only a log with no text at all loses its oldest event. A
 * permission card that is still open is never dropped: a panel that reconnects must still see it.
 * `seq` numbers are never reused or renumbered, so merged and dropped entries leave gaps (the
 * contract allows them: `conversation-page.events` carries each entry's own `seq`).
 */

export const CONVERSATION_LOG_CAP_BYTES = 256 * 1024;
/** The contract's bound on entries per page (`conversationPageFrameSchema`). */
const PAGE_MAX_ENTRIES = 4096;
const ELLIPSIS = "…";

export type ConversationLogEntry = { seq: number; event: ConversationEvent };
export type ConversationPage = { fromSeq: number; events: ConversationLogEntry[]; more: boolean };

const entrySize = (entry: ConversationLogEntry) => JSON.stringify(entry).length;

export class ConversationEventLog {
  private readonly capBytes: number;
  private readonly list: ConversationLogEntry[] = [];
  private readonly sizes: number[] = [];
  /** Sum of the entries' JSON lengths; `bytes` adds the brackets and commas. */
  private total = 0;
  private nextSeq = 0;
  /** Cards raised and not yet closed (R-318: never dropped). */
  private readonly openCards = new Set<string>();

  constructor(options: { capBytes?: number } = {}) {
    this.capBytes = options.capBytes ?? CONVERSATION_LOG_CAP_BYTES;
  }

  /** `JSON.stringify(entries).length`, kept without re-serialising. */
  get bytes(): number {
    return this.list.length === 0 ? 2 : this.total + this.list.length + 1;
  }

  get entries(): readonly ConversationLogEntry[] {
    return this.list;
  }

  /** The seq the next event will get: one more than any seq handed out so far. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Appends one event, returns its seq, then brings the log back under the cap. */
  append(event: ConversationEvent): number {
    const seq = this.nextSeq++;
    if (event.type === "permission") this.openCards.add(event.requestId);
    if (event.type === "permission-closed") this.openCards.delete(event.requestId);
    this.push({ seq, event });
    this.enforceCap();
    return seq;
  }

  /**
   * The entries from `fromSeq` on, as many as fit `maxBytes` of JSON and 4096 entries; `more` when
   * entries remain after them. The first entry always goes out even if it alone were larger (it
   * cannot be: one event is at most ~90 KB - an owner message with five 12 000-character thumbnails
   * and its other attachments (022) - well under the 256 KiB page), so a reader always makes progress.
   */
  page(fromSeq: number, maxBytes: number = CONVERSATION_PAGE_MAX_BYTES): ConversationPage {
    const start = this.list.findIndex((entry) => entry.seq >= fromSeq);
    if (start < 0) return { fromSeq, events: [], more: false };
    const events: ConversationLogEntry[] = [];
    let size = 2;
    let index = start;
    for (; index < this.list.length && events.length < PAGE_MAX_ENTRIES; index++) {
      const add = this.sizes[index]! + (events.length === 0 ? 0 : 1);
      if (events.length > 0 && size + add > maxBytes) break;
      events.push(this.list[index]!);
      size += add;
    }
    return { fromSeq, events, more: index < this.list.length };
  }

  private push(entry: ConversationLogEntry): void {
    const size = entrySize(entry);
    this.list.push(entry);
    this.sizes.push(size);
    this.total += size;
  }

  private replace(index: number, entry: ConversationLogEntry): void {
    const size = entrySize(entry);
    this.total += size - this.sizes[index]!;
    this.list[index] = entry;
    this.sizes[index] = size;
  }

  private removeAt(index: number): void {
    this.total -= this.sizes[index]!;
    this.list.splice(index, 1);
    this.sizes.splice(index, 1);
  }

  private enforceCap(): void {
    while (this.bytes > this.capBytes && this.list.length > 1) {
      if (this.mergeOldestText()) continue;
      const text = this.list.findIndex((entry, index) => entry.event.type === "text" && index < this.list.length - 1);
      if (text >= 0) {
        this.removeAt(text);
        continue;
      }
      const droppable = this.list.findIndex(
        (entry, index) =>
          index < this.list.length - 1 && !(entry.event.type === "permission" && this.openCards.has(entry.event.requestId)),
      );
      if (droppable < 0) return;
      this.removeAt(droppable);
    }
  }

  /** Merges the oldest adjacent pair of same-speaker text entries (never the newest entry); false if none. */
  private mergeOldestText(): boolean {
    for (let index = 0; index + 2 < this.list.length; index++) {
      const older = this.list[index]!.event;
      const newer = this.list[index + 1]!.event;
      if (older.type !== "text" || newer.type !== "text" || older.role !== newer.role) continue;
      // 022: a message with attachments is never merged (that would strip them); it can only go whole.
      if (older.attachments !== undefined || newer.attachments !== undefined) continue;
      const merged = older.text + newer.text;
      // Keep the newer end; over one event's bound, and in any case shrinking when merged would not
      // shrink the log (two entries' JSON overhead is small), cut the older half's words.
      const room = Math.min(CONVERSATION_TEXT_MAX_CHARS, Math.max(newer.text.length, Math.floor(merged.length / 2)));
      const text = merged.length <= room ? merged : `${ELLIPSIS}${merged.slice(merged.length - room + 1)}`;
      this.replace(index, { seq: this.list[index]!.seq, event: { type: "text", role: older.role, text } });
      this.removeAt(index + 1);
      return true;
    }
    return false;
  }
}
