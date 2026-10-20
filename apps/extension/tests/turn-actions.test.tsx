import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import type { TurnActionGroup } from "../src/side-panel/agent/conversation/conversation-log.js";
import { TurnActions } from "../src/side-panel/agent/conversation/TurnActions.js";

/**
 * 020/T595 - a turn's actions stay out of the way (US3, FR-318): one live line while the turn runs,
 * "N steps" collapsed afterwards that expands to FR-287's detail, failed and refused actions always
 * in view.
 */

const t = (key: string): string => lookup(key, "en-US");
type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;
const tool = (toolCallId: string, status: ToolEvent["status"], title = `Read ${toolCallId}`): ToolEvent => ({
  type: "tool",
  toolCallId,
  kind: "read",
  title,
  inputSummary: `${toolCallId}.txt`,
  status,
});
const group = (parts: Partial<TurnActionGroup>): TurnActionGroup => ({
  kind: "turn-actions",
  key: "actions-1",
  running: false,
  steps: [],
  problems: [],
  ...parts,
});
const stepsLabel = (count: number) => t("conversation.turn.steps").replace("{count}", String(count));

afterEach(cleanup);

describe("T595 a turn's actions", () => {
  it("while the turn runs, shows one polite live line, changed only when the action does", () => {
    const first = tool("a", "running");
    const view = render(<TurnActions group={group({ running: true, steps: [first], live: first })} t={t} />);

    const live = view.container.querySelector("[aria-live]")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain("Read a");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();

    // The same action reported again (a new status, a reworded title): nothing new to announce.
    const again = { ...first, title: "Read a (2 KB)" };
    view.rerender(<TurnActions group={group({ running: true, steps: [again], live: again })} t={t} />);
    expect(live.textContent).toContain("Read a");
    expect(live.textContent).not.toContain("2 KB");

    const second = tool("b", "running");
    view.rerender(<TurnActions group={group({ running: true, steps: [again, second], live: second })} t={t} />);
    expect(view.container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(live.textContent).toContain("Read b");
  });

  it("after the turn, folds the steps into 'N steps' and lists each with name, input and status when expanded", () => {
    const steps = ["a", "b", "c", "d", "e"].map((id) => tool(id, "done"));
    render(<TurnActions group={group({ steps, problems: [tool("x", "failed", "Run npm test")] })} t={t} />);

    const toggle = screen.getByRole("button", { name: stepsLabel(5) });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: t("conversation.actions.label") })).toBeNull();

    // The failed one is in view before anything is expanded.
    const problems = screen.getByRole("list", { name: t("conversation.turn.problems") });
    expect(problems.textContent).toContain("Run npm test");
    expect(problems.textContent).toContain(t("conversation.action.status.failed"));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: t("conversation.actions.label") });
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain("Read a");
    expect(rows[0]?.textContent).toContain("a.txt");
    expect(rows[0]?.textContent).toContain(t("conversation.action.status.done"));

    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: t("conversation.actions.label") })).toBeNull();
  });

  it("says one step in the singular, and shows no toggle when every action went wrong", () => {
    render(<TurnActions group={group({ steps: [tool("a", "done")] })} t={t} />);
    expect(screen.getByRole("button", { name: t("conversation.turn.step") })).toBeTruthy();
    cleanup();

    render(<TurnActions group={group({ problems: [tool("x", "refused")] })} t={t} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("list", { name: t("conversation.turn.problems") }).textContent).toContain(
      t("conversation.action.status.refused"),
    );
  });

  it("does not repeat an input the title already holds, and keeps one that adds something (T602)", () => {
    const read = { ...tool("r", "running"), title: "Read src/cart/pricing.ts", inputSummary: "src/cart/pricing.ts" };
    const view = render(<TurnActions group={group({ running: true, steps: [read], live: read })} t={t} />);
    expect(view.container.querySelector(".agent-conversation-live .agent-conversation-action-input")).toBeNull();
    expect(view.container.querySelector(".agent-conversation-live")?.textContent).toContain("Read src/cart/pricing.ts");
    cleanup();

    const run = { ...tool("n", "failed"), kind: "execute" as const, title: "Run `npm test -- checkout`", inputSummary: " npm test -- checkout " };
    const page = { ...tool("p", "done"), title: "Read page", inputSummary: "https://shop.test/" };
    render(<TurnActions group={group({ steps: [page, run], problems: [run] })} t={t} />);
    const problems = screen.getByRole("list", { name: t("conversation.turn.problems") });
    expect(problems.querySelector(".agent-conversation-action-input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: stepsLabel(2) }));
    const rows = within(screen.getByRole("list", { name: t("conversation.actions.label") })).getAllByRole("listitem");
    expect(rows[0]?.querySelector(".agent-conversation-action-input")?.textContent).toBe("https://shop.test/");
    expect(rows[1]?.querySelector(".agent-conversation-action-input")).toBeNull();
  });
});
