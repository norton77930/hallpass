import {
  CONVERSATION_FILE_MAX_BYTES,
  CONVERSATION_FILES_TOTAL_MAX_BYTES,
  CONVERSATION_MAX_FILES,
  CONVERSATION_MAX_IMAGES,
  CONVERSATION_MAX_TABS,
  type ConversationAccepts,
  type ConversationAttachmentKind,
} from "@hallpass/contracts";

/**
 * 022 data-model "DraftAttachment": one attachment in a conversation's unsent message, in this panel
 * document's memory only. Nothing of it leaves before Send (R-338).
 *
 * `localId` is a random UUID and becomes the `attachmentId` the broker stages it under: unpredictable,
 * never a counter (S1 architecture review). `bytes` is what travels: a picture's encoded bytes, the
 * tab's UTF-8 text, or a file (kept as the Blob the owner gave, read piece by piece at Send).
 */
export type DraftAttachment = {
  localId: string;
  kind: ConversationAttachmentKind;
  name: string;
  /** Bytes: a picture's encoded size, a file's size, the tab text's UTF-8 size. */
  size: number;
  state: "preparing" | "ready" | "refused";
  refusal?: Refusal;
  mimeType?: string;
  bytes?: Blob | Uint8Array;
  thumbnail?: string;
  tab?: { url: string; title: string; cut: boolean };
};

/** A refusal in the panel's words: a locale key and the values put into it (FR-339). */
export type Refusal = { key: string; vars?: Readonly<Record<string, string>>; then?: string };

/** The unsent message of one conversation (or of the empty conversation): its words and attachments. */
export type ComposerDraft = {
  text: string;
  attachments: readonly DraftAttachment[];
  /** The last refusal, said under the chips until the next add, remove or send. */
  refusal?: Refusal;
  /** The message is on its way (pieces leaving); the box is held. */
  sending?: boolean;
};

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };

export const mintAttachmentId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : // Only an engine without randomUUID; the panel's Chrome always has it.
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** What an agent takes; unknown is everything (R-344: the broker decides). */
export const acceptsImages = (accepts: ConversationAccepts | undefined): boolean => accepts?.image !== false;
export const acceptsContext = (accepts: ConversationAccepts | undefined): boolean => accepts?.context !== false;

/** The attachments that count against the limits and travel: not the refused ones. */
const live = (attachments: readonly DraftAttachment[]) => attachments.filter((attachment) => attachment.state !== "refused");

/**
 * FR-328: whether one more attachment of this kind and size may join the message, or the refusal
 * that says which limit it hit. Checked when it is added, never at Send.
 */
export function admit(
  attachments: readonly DraftAttachment[],
  candidate: { kind: ConversationAttachmentKind; name: string; size: number },
): Refusal | undefined {
  const counted = live(attachments);
  const count = (kind: ConversationAttachmentKind) => counted.filter((attachment) => attachment.kind === kind).length;
  if (candidate.kind === "image") {
    return count("image") >= CONVERSATION_MAX_IMAGES ? { key: "conversation.attach.refused.tooManyImages" } : undefined;
  }
  if (candidate.kind === "tab") {
    return count("tab") >= CONVERSATION_MAX_TABS ? { key: "conversation.attach.refused.oneTab" } : undefined;
  }
  if (candidate.size > CONVERSATION_FILE_MAX_BYTES) {
    return { key: "conversation.attach.refused.fileTooLarge", vars: { name: candidate.name } };
  }
  if (count("file") >= CONVERSATION_MAX_FILES) return { key: "conversation.attach.refused.tooManyFiles" };
  const files = counted.filter((attachment) => attachment.kind === "file").reduce((sum, attachment) => sum + attachment.size, 0);
  if (files + candidate.size > CONVERSATION_FILES_TOTAL_MAX_BYTES) return { key: "conversation.attach.refused.filesTooLarge" };
  return undefined;
}

/** FR-336: Send is possible with words or a ready attachment, and never while one is being prepared. */
export function draftSendable(draft: ComposerDraft): boolean {
  if (draft.sending === true) return false;
  if (draft.attachments.some((attachment) => attachment.state === "preparing")) return false;
  return draft.text.trim() !== "" || draft.attachments.some((attachment) => attachment.state === "ready");
}

/** The attachments a Send carries: the ready ones, in the order the owner added them. */
export const readyAttachments = (draft: ComposerDraft): DraftAttachment[] =>
  draft.attachments.filter((attachment) => attachment.state === "ready");

/** A size as the chips say it: "820 B", "3 KB", "2.9 KB", "1.2 MB" (units are the same in both languages). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const round = (value: number) => String(Math.round(value * 10) / 10);
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes / (1024 * 1024))} MB`;
}

/** A refusal in the owner's language, with its values put in. */
export function refusalWords(refusal: Refusal, t: (key: string) => string): string[] {
  let words = t(refusal.key);
  for (const [name, value] of Object.entries(refusal.vars ?? {})) words = words.replaceAll(`{${name}}`, () => value);
  return refusal.then === undefined ? [words] : [words, t(refusal.then)];
}
