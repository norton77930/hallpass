import type { AgentToolName } from "@hallpass/contracts";
import type { AgentTarget } from "./refs.js";

/**
 * What the owner is shown about a call they have not yet approved (003/T028, T048).
 *
 * Built from the tool and the *shape* of its arguments, never from the arguments themselves: the
 * panel must be able to render this without interpreting a handle or a page string (FR-035). It is
 * shared by the single-effect `ask` prompt and by the plan prompt a whole batch raises, so the
 * owner reads the same sentence for the same call whichever way it reached them.
 */

function where(args: Record<string, unknown>): string {
  const target = args.target as AgentTarget | undefined;
  if (target === undefined) return "the focused element";
  if (typeof (target as { ref?: unknown }).ref === "string") return "a page element";
  return `the point ${(target as { x: number }).x}, ${(target as { y: number }).y}`;
}

export function summariseToolCall(tool: AgentToolName, args: Record<string, unknown>): string {
  if (tool === "type") return `type text into ${where(args)}`;
  if (tool === "key") return `press ${String(args.key)} on ${where(args)}`;
  if (tool === "scroll") return args.target === undefined ? "scroll the page" : "scroll a page element into view";
  if (tool === "drag") return "drag one page element onto another";
  if (tool === "form_input") return "set a form control's value";
  // US6 scenario 3: what the owner is agreeing to is a script running on the page, which is why
  // this is asked at all - and the expression itself is deliberately not shown, for the same reason
  // no other argument is: the panel decides nothing about a call it would have to interpret.
  if (tool === "evaluate") return "run a script on the page";
  /**
   * US7: the one call whose target is a place rather than a thing. The action is named because it
   * is the difference between a click and typing; the coordinate is not, because a pair of numbers
   * tells the owner nothing - the prompt carries a crop of that place instead (FR-069).
   */
  if (tool === "computer") {
    const action = String(args.action ?? "").replace(/_/g, " ");
    return args.x === undefined ? `${action} on the page` : `${action} at a point on the page`;
  }
  // US7: what the owner is agreeing to is a file of theirs going into a form on this page. How many,
  // never which - a file name is the owner's own data and the panel does not need it to decide.
  if (tool === "file_upload") {
    const count = Array.isArray(args.files) ? args.files.length : 1;
    return count === 1 ? "put one of your files into a form on the page" : `put ${count} of your files into a form on the page`;
  }
  /**
   * The tools that never raise an `ask` prompt of their own, but do appear inside a batch the owner
   * is asked about as a whole. Each is one plain sentence about what the step does, for the same
   * reason the effects are: the owner is deciding about a sequence, and a step they cannot read is
   * a step they cannot strike out.
   */
  if (tool === "navigate") return "go to another page in this tab";
  if (tool === "find") return "look for an element on the page";
  if (tool === "read_page" || tool === "get_page_text") return "read the page";
  if (tool === "screenshot") return "take a picture of the page";
  if (tool === "wait") return "wait for the page";
  if (tool === "tabs_context") return "list this session's tabs";
  if (tool === "resize_window") return "resize the window";
  return `${tool.replace("_", " ")} ${where(args)}`;
}
