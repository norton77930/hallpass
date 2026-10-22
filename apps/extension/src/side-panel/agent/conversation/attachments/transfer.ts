import { CONVERSATION_ERROR_CODES, type ConversationError, type ConversationPanelResult } from "@hallpass/contracts";
import type { ConversationRequest, RequestCommand } from "../../AgentShell.js";
import { blobBytes, bytesToBase64, PIECE_MAX_BYTES } from "./bytes.js";
import type { DraftAttachment, Refusal } from "./model.js";

/**
 * 022 R-337, R-338, FR-332: a message with attachments, handed over at Send - after the conversation
 * exists (020 start-then-send).
 *
 * Each attachment leaves as `ui.conversation.attach` pieces of at most 512 KiB of raw bytes, in
 * order, one at a time: the next piece waits for the broker's answer to the last (its own
 * `conversation-result`, through `request`). Only when every piece of every attachment was taken does
 * `ui.conversation.send` name them, with the words (which may be empty).
 *
 * Any failure ends it with nothing sent: a refused piece or send, no answer within 30 s (an invalid
 * command gets none), the connection gone, or the transfer given up (`signal`: the conversation was
 * left, the panel closed). Every attachment already begun is then cancelled with
 * `ui.conversation.attach-cancel`, best effort, and the caller keeps the words and the chips.
 */

export const PIECE_TIMEOUT_MS = 30_000;

export type TransferOutcome =
  | { ok: true }
  | { ok: false; refusal: Refusal; aborted: boolean };

class Stopped extends Error {
  constructor(
    readonly refusal: Refusal,
    readonly aborted: boolean,
  ) {
    super("transfer stopped");
  }
}

const NOT_SENT = "conversation.attach.refused.notSent";
const TRANSFER_FAILED: Refusal = { key: "conversation.attach.refused.transfer" };

/** The broker's refusal in the panel's words: its own code's sentence, then "nothing was sent". */
function refusalOf(error: ConversationError): Refusal {
  return (CONVERSATION_ERROR_CODES as readonly string[]).includes(error.code)
    ? { key: `conversation.error.${error.code}`, then: NOT_SENT }
    : TRANSFER_FAILED;
}

/** Waits for one answer, at most `timeoutMs`, and no longer than the transfer is wanted. */
async function answered(
  pending: Promise<ConversationPanelResult>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ConversationPanelResult> {
  if (signal.aborted) throw new Stopped(TRANSFER_FAILED, true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Stopped(TRANSFER_FAILED, false)), timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Stopped(TRANSFER_FAILED, true));
        signal.addEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Bytes in memory rather than a Blob (checked by shape: a TextEncoder's array may be another realm's). */
const inMemory = (bytes: Blob | Uint8Array): bytes is Uint8Array => ArrayBuffer.isView(bytes);

/** The piece `index` of an attachment's bytes, as base64. */
async function piece(bytes: Blob | Uint8Array, index: number): Promise<string> {
  const start = index * PIECE_MAX_BYTES;
  const end = start + PIECE_MAX_BYTES;
  const raw = inMemory(bytes) ? bytes.subarray(start, end) : await blobBytes(bytes.slice(start, end));
  return bytesToBase64(raw);
}

const byteLength = (bytes: Blob | Uint8Array): number => (inMemory(bytes) ? bytes.length : bytes.size);

/** What the first piece says about the attachment (and only the first, contracts/attachments.md). */
function firstPieceFields(attachment: DraftAttachment) {
  return {
    kind: attachment.kind,
    name: attachment.name,
    size: attachment.size,
    ...(attachment.kind === "image" && attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.kind === "image" && attachment.thumbnail !== undefined ? { thumbnail: attachment.thumbnail } : {}),
    ...(attachment.kind === "tab" && attachment.tab !== undefined ? { tab: attachment.tab } : {}),
  };
}

export async function transferMessage(options: {
  conversationId: string;
  text: string;
  attachments: readonly DraftAttachment[];
  activeTabId?: number;
  request: RequestCommand;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<TransferOutcome> {
  const { conversationId, request, signal } = options;
  const timeoutMs = options.timeoutMs ?? PIECE_TIMEOUT_MS;
  const begun: string[] = [];
  const ask = async (command: ConversationRequest): Promise<void> => {
    const result = await answered(request(command), signal, timeoutMs);
    if (!result.ok) throw new Stopped(refusalOf(result.error), false);
  };
  try {
    for (const attachment of options.attachments) {
      const bytes = attachment.bytes ?? new Uint8Array(0);
      const total = byteLength(bytes);
      const count = Math.max(1, Math.ceil(total / PIECE_MAX_BYTES));
      for (let index = 0; index < count; index += 1) {
        if (signal.aborted) throw new Stopped(TRANSFER_FAILED, true);
        const data = await piece(bytes, index);
        if (index === 0) begun.push(attachment.localId);
        await ask({
          type: "ui.conversation.attach",
          payload: {
            conversationId,
            attachmentId: attachment.localId,
            index,
            final: index === count - 1,
            ...(index === 0 ? firstPieceFields(attachment) : {}),
            data,
          },
        });
      }
    }
    if (signal.aborted) throw new Stopped(TRANSFER_FAILED, true);
    await ask({
      type: "ui.conversation.send",
      payload: {
        conversationId,
        text: options.text,
        ...(options.activeTabId === undefined ? {} : { activeTabId: options.activeTabId }),
        ...(begun.length === 0 ? {} : { attachments: begun }),
      },
    });
    return { ok: true };
  } catch (error) {
    // Best effort: the broker drops what it staged; an answer to these is not waited for.
    for (const attachmentId of begun) {
      void request({ type: "ui.conversation.attach-cancel", payload: { conversationId, attachmentId } });
    }
    if (error instanceof Stopped) return { ok: false, refusal: error.refusal, aborted: error.aborted };
    return { ok: false, refusal: TRANSFER_FAILED, aborted: false };
  }
}
