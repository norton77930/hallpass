import { useRef, useState } from "react";
import { CONVERSATION_IMAGE_MAX_CHARS, type ConversationAccepts, type TabCaptureResult } from "@hallpass/contracts";
import type { CaptureTab } from "../../AgentShell.js";
import { base64ToBytes, utf8Bytes } from "./bytes.js";
import {
  acceptsContext,
  acceptsImages,
  admit,
  EMPTY_DRAFT,
  mintAttachmentId,
  type ComposerDraft,
  type DraftAttachment,
  type Refusal,
} from "./model.js";
import { isImageType, LONG_EDGE, prepareImage, thumbnailFor } from "./prepare-image.js";

/**
 * 022 D-022-5, FR-335, US5: each conversation's unsent message - its words and its attachments -
 * kept per conversation (and one for the empty conversation) for as long as this panel document is
 * open, so switching to another conversation and back finds them where they were, and the other
 * conversation never shows them. Memory only (R-338).
 *
 * The store is a ref read and written synchronously (an add checks the limits against what is
 * really there, even several in one event); a counter makes the tab draw again.
 */

/** The empty conversation's own draft (conversation ids are `conv-…`, so this never collides). */
export const NEW_DRAFT_KEY = "new";

export type DraftStore = {
  get: (key: string) => ComposerDraft;
  update: (key: string, change: (draft: ComposerDraft) => ComposerDraft) => void;
  /** T633: forgets a conversation's draft (it was removed). */
  drop: (key: string) => void;
  keys: () => string[];
};

export function useDraftStore(): DraftStore {
  const drafts = useRef<Record<string, ComposerDraft>>({});
  const [, redraw] = useState(0);
  return {
    get: (key) => drafts.current[key] ?? EMPTY_DRAFT,
    update: (key, change) => {
      drafts.current = { ...drafts.current, [key]: change(drafts.current[key] ?? EMPTY_DRAFT) };
      redraw((count) => count + 1);
    },
    drop: (key) => {
      if (!(key in drafts.current)) return;
      const { [key]: _dropped, ...rest } = drafts.current;
      drafts.current = rest;
      redraw((count) => count + 1);
    },
    keys: () => Object.keys(drafts.current),
  };
}

/**
 * T633 (FR-335): what the composer keeps for as long as the panel document is open - the drafts and
 * the transfers under way, by conversation. Held by the shell, above the Conversation /
 * Connections & sites switch, so showing the other tab neither gives up a message on its way nor
 * loses a chip, a refusal or a capture still being made.
 */
export type ComposerMemory = { drafts: DraftStore; transfers: Map<string, AbortController> };

export function useComposerMemory(): ComposerMemory {
  const drafts = useDraftStore();
  const transfers = useRef(new Map<string, AbortController>());
  return { drafts, transfers: transfers.current };
}

/** T633: the drafts of conversations no longer in the list go (the empty conversation's stays). */
export function pruneDrafts(store: DraftStore, live: ReadonlySet<string>): void {
  for (const key of store.keys()) {
    if (key !== NEW_DRAFT_KEY && !live.has(key)) store.drop(key);
  }
}

export type AddContext = { accepts: ConversationAccepts | undefined; agentName: string };

const refuse = (store: DraftStore, key: string, refusal: Refusal): void =>
  store.update(key, (draft) => ({ ...draft, refusal }));

const replace = (store: DraftStore, key: string, localId: string, next: DraftAttachment | undefined): void =>
  store.update(key, (draft) => ({
    ...draft,
    attachments: next === undefined
      ? draft.attachments.filter((attachment) => attachment.localId !== localId)
      : draft.attachments.map((attachment) => (attachment.localId === localId ? next : attachment)),
  }));

/** Adds an attachment when the limits allow it; otherwise says which limit it hit. */
function tryAdd(store: DraftStore, key: string, attachment: DraftAttachment): boolean {
  const refusal = admit(store.get(key).attachments, attachment);
  if (refusal !== undefined) {
    refuse(store, key, refusal);
    return false;
  }
  store.update(key, (draft) => {
    const { refusal: _cleared, ...rest } = draft;
    return { ...rest, attachments: [...draft.attachments, attachment] };
  });
  return true;
}

/** A picture made ready (or refused), in the place its "preparing" chip holds. */
async function prepareInto(store: DraftStore, key: string, chip: DraftAttachment, source: Blob): Promise<void> {
  const outcome = await prepareImage(source);
  if (!store.get(key).attachments.some((attachment) => attachment.localId === chip.localId)) return;
  if (!outcome.ok) {
    replace(store, key, chip.localId, {
      ...chip,
      state: "refused",
      refusal: {
        key: outcome.reason === "not-image" ? "conversation.attach.refused.notImage" : "conversation.attach.refused.imageTooLarge",
        vars: { name: chip.name },
      },
    });
    return;
  }
  const { image } = outcome;
  replace(store, key, chip.localId, {
    ...chip,
    state: "ready",
    size: image.size,
    mimeType: image.mimeType,
    bytes: base64ToBytes(image.data),
    ...(image.thumbnail === undefined ? {} : { thumbnail: image.thumbnail }),
  });
}

/**
 * FR-326, FR-327, FR-328: files picked, pasted or dropped. A PNG, JPEG, GIF or WebP is a picture
 * (prepared in the panel); anything else is a file, copied into the conversation folder at Send.
 */
export function addFiles(store: DraftStore, key: string, files: readonly File[], context: AddContext): void {
  for (const file of files) {
    const image = isImageType(file.type);
    if (image && !acceptsImages(context.accepts)) {
      refuse(store, key, { key: "conversation.attach.noImages", vars: { agent: context.agentName } });
      continue;
    }
    const chip: DraftAttachment = {
      localId: mintAttachmentId(),
      kind: image ? "image" : "file",
      name: file.name === "" ? (image ? "image.png" : "file") : file.name,
      size: file.size,
      state: image ? "preparing" : "ready",
      ...(image ? {} : { bytes: file }),
    };
    if (tryAdd(store, key, chip) && image) void prepareInto(store, key, chip, file);
  }
}

/**
 * T633: a worker screenshot is already encoded within the image bound; when its long edge is within
 * R-341's too, it goes as it is and only the thumbnail is made here.
 */
function fitsAsIs(
  result: Extract<TabCaptureResult, { kind: "image" }>,
): result is Extract<TabCaptureResult, { kind: "image" }> & { mimeType: "image/png" | "image/jpeg" } {
  return (
    (result.mimeType === "image/png" || result.mimeType === "image/jpeg") &&
    result.data.length <= CONVERSATION_IMAGE_MAX_CHARS &&
    Math.max(result.width, result.height) <= LONG_EDGE
  );
}

/**
 * FR-329, FR-330: "Screenshot of this tab" / "Attach this tab". A chip waits as "preparing" while
 * the worker captures; what comes back takes its place - a picture, the page as a tab chip, or a PDF
 * tab as a file - or the refusal is said and the chip goes.
 */
export async function addCapture(
  store: DraftStore,
  key: string,
  what: "screenshot" | "page",
  context: AddContext & { captureTab: CaptureTab; tabId: number; screenshotName: string; tabName: string },
): Promise<void> {
  const placeholder: DraftAttachment = {
    localId: mintAttachmentId(),
    kind: what === "screenshot" ? "image" : "tab",
    name: what === "screenshot" ? context.screenshotName : context.tabName,
    size: 0,
    state: "preparing",
  };
  if (!tryAdd(store, key, placeholder)) return;
  // The wait is bounded by the shell's `captureTab` (30 s for a picture, 90 s for a page or a PDF).
  const result = await context.captureTab(context.tabId, what);
  if (!store.get(key).attachments.some((attachment) => attachment.localId === placeholder.localId)) return;
  if (!result.ok) {
    replace(store, key, placeholder.localId, undefined);
    refuse(store, key, { key: `conversation.attach.capture.${result.code}` });
    return;
  }
  if (result.kind === "image" && fitsAsIs(result)) {
    const bytes = base64ToBytes(result.data);
    const thumbnail = await thumbnailFor(new Blob([bytes as BlobPart], { type: result.mimeType }));
    if (!store.get(key).attachments.some((attachment) => attachment.localId === placeholder.localId)) return;
    replace(store, key, placeholder.localId, {
      ...placeholder,
      state: "ready",
      size: bytes.length,
      mimeType: result.mimeType,
      bytes,
      ...(thumbnail === undefined ? {} : { thumbnail }),
    });
    return;
  }
  if (result.kind === "image") {
    await prepareInto(store, key, placeholder, new Blob([base64ToBytes(result.data) as BlobPart], { type: result.mimeType }));
    return;
  }
  // The placeholder leaves; what came back is checked against the limits as any other add.
  replace(store, key, placeholder.localId, undefined);
  if (result.kind === "page") {
    if (!acceptsContext(context.accepts)) {
      refuse(store, key, { key: "conversation.attach.noContext", vars: { agent: context.agentName } });
      return;
    }
    const bytes = utf8Bytes(result.text);
    tryAdd(store, key, {
      localId: placeholder.localId,
      kind: "tab",
      name: (result.title.trim() === "" ? result.url : result.title).slice(0, 255) || context.tabName,
      size: bytes.length,
      state: "ready",
      bytes,
      tab: { url: result.url, title: result.title, cut: result.cut },
    });
    return;
  }
  tryAdd(store, key, {
    localId: placeholder.localId,
    kind: "file",
    name: result.name,
    size: result.size,
    state: "ready",
    mimeType: result.mimeType,
    bytes: base64ToBytes(result.data),
  });
}

/** FR-335: a chip removed - nothing of it is anywhere else yet (R-338). */
export function removeAttachment(store: DraftStore, key: string, localId: string): void {
  store.update(key, (draft) => {
    const { refusal: _cleared, ...rest } = draft;
    return { ...rest, attachments: draft.attachments.filter((attachment) => attachment.localId !== localId) };
  });
}
