import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "@hallpass/contracts";
import { groupTurns, pictureOf, type ConversationLogEntry } from "../src/side-panel/agent/conversation/conversation-log.js";

/**
 * 020/T594 (R-334, FR-318): a turn is everything between one owner message and the next. Its
 * actions are one group; while the turn runs the newest running action is the live one; failed and
 * refused actions are kept apart from the steps so the collapsed group never hides them.
 */

type ToolStatus = Extract<ConversationEvent, { type: "tool" }>["status"];
const tool = (toolCallId: string, status: ToolStatus, title = toolCallId): ConversationEvent => ({
  type: "tool",
  toolCallId,
  kind: "read",
  title,
  inputSummary: `input of ${toolCallId}`,
  status,
});
const owner = (text: string): ConversationEvent => ({ type: "text", role: "owner", text });
const agent = (text: string): ConversationEvent => ({ type: "text", role: "agent", text });
const entries = (events: ConversationEvent[]): ConversationLogEntry[] => events.map((event, seq) => ({ seq, event }));
const grouped = (events: ConversationEvent[], turnUnderWay: boolean) => groupTurns(pictureOf(entries(events)).timeline, turnUnderWay);

describe("T594 grouping a conversation's actions by turn", () => {
  it("gathers a finished turn's actions into one group, failed and refused apart, before its last words", () => {
    const items = grouped(
      [
        owner("tidy the table"),
        agent("Looking."),
        tool("r1", "done"),
        tool("r2", "done"),
        agent("Now the edit."),
        tool("r3", "done"),
        tool("x1", "failed"),
        tool("r4", "done"),
        tool("x2", "refused"),
        tool("r5", "done"),
        agent("Done."),
      ],
      false,
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "text", "text", "turn-actions", "text"]);
    const group = items[3]!;
    if (group.kind !== "turn-actions") throw new Error("not a group");
    expect(group.running).toBe(false);
    expect(group.steps.map((step) => step.toolCallId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(group.problems.map((step) => step.toolCallId)).toEqual(["x1", "x2"]);
    expect(group.live).toBeUndefined();
  });

  it("starts a new turn at each owner message, so earlier turns are finished while the last one runs", () => {
    const items = grouped([owner("one"), tool("a", "done"), owner("two"), tool("b", "done"), tool("c", "running")], true);

    const groups = items.filter((item) => item.kind === "turn-actions");
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.running)).toEqual([false, true]);
    expect(groups[0]!.steps.map((step) => step.toolCallId)).toEqual(["a"]);
    expect(groups[1]!.steps.map((step) => step.toolCallId)).toEqual(["b", "c"]);
    expect(items.map((item) => item.kind)).toEqual(["text", "turn-actions", "text", "turn-actions"]);
  });

  it("names the newest running action as the live one, with its latest status", () => {
    const items = grouped(
      [owner("go"), tool("a", "running"), tool("b", "running"), tool("c", "done"), tool("b", "running", "b renamed")],
      true,
    );
    const group = items.find((item) => item.kind === "turn-actions");
    expect(group?.live?.toolCallId).toBe("b");
    expect(group?.live?.title).toBe("b renamed");
  });

  it("falls back to the newest pending action, and has no live one when nothing is in progress", () => {
    const pending = grouped([owner("go"), tool("a", "done"), tool("b", "pending")], true).find((item) => item.kind === "turn-actions");
    expect(pending?.live?.toolCallId).toBe("b");

    const idle = grouped([owner("go"), tool("a", "done"), tool("x", "failed")], true).find((item) => item.kind === "turn-actions");
    expect(idle?.running).toBe(true);
    expect(idle?.live).toBeUndefined();
    expect(idle?.problems.map((step) => step.toolCallId)).toEqual(["x"]);
  });

  it("leaves a timeline without actions as it was", () => {
    const timeline = pictureOf(entries([owner("hi"), agent("hello")])).timeline;
    expect(groupTurns(timeline, false)).toEqual(timeline);
  });
});
