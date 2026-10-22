import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 022 T630, FR-338, R-343: the owner's bubble shows what the message carried - pictures as
 * thumbnails, a file as a name chip whose hover is its path in the folder, the tab as a name chip
 * marked when its text was cut. A picture the agent replays (no thumbnail) is a picture chip.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const bubble = () => document.querySelector<HTMLElement>("[data-message-role='owner']")!;

describe("022 FR-338 attachments in the owner's bubble", () => {
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("shows a thumbnail for a picture, a file chip with its path, and the tab marked as cut", () => {
    emitEvent(port, 1, {
      type: "text",
      role: "owner",
      text: "what now?",
      attachments: [
        { kind: "image", name: "error.png", size: 3000, thumbnail: "AAAA" },
        { kind: "file", name: "data (2).csv", size: 2048, path: "C:\\work\\hallpass-attachments\\data (2).csv" },
        { kind: "tab", name: "A long article", cut: true },
      ],
    });
    const owner = bubble();
    expect(owner.textContent).toContain("what now?");
    const image = owner.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(image.getAttribute("alt")).toBe("error.png");
    const file = owner.querySelector<HTMLElement>("[data-attachment-kind='file']")!;
    expect(file.textContent).toContain("data (2).csv");
    expect(file.getAttribute("title")).toBe("C:\\work\\hallpass-attachments\\data (2).csv");
    const tab = owner.querySelector<HTMLElement>("[data-attachment-kind='tab']")!;
    expect(tab.textContent).toContain("A long article");
    expect(tab.querySelector("[data-cut]")?.textContent).toBe(ui("conversation.attachment.cut"));
  });

  it("shows a message that is only attachments", () => {
    emitEvent(port, 1, { type: "text", role: "owner", text: "", attachments: [{ kind: "file", name: "log.txt" }] });
    expect(bubble().querySelector("[data-attachment-kind='file']")?.textContent).toContain("log.txt");
    expect(bubble().querySelector("p")).toBeNull();
  });

  it("shows a replayed picture, which has no thumbnail, as a picture chip", () => {
    emitEvent(port, 1, { type: "text", role: "owner", text: "look", attachments: [{ kind: "image", name: "image" }] });
    const chip = bubble().querySelector<HTMLElement>("[data-attachment-kind='image']")!;
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.textContent).toContain("image");
  });

  it("names the attachments for a screen reader", () => {
    emitEvent(port, 1, { type: "text", role: "owner", text: "x", attachments: [{ kind: "file", name: "log.txt" }] });
    expect(screen.getByRole("list", { name: ui("conversation.attachments.label") })).toBeTruthy();
  });
});
