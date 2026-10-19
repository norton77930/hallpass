import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBrowserAncestor, type ProcessFacts } from "../src/broker/browser-process.js";
import { createBrokerLifetime } from "../src/broker/lifetime.js";

/**
 * 019/T575 (D-019-14, FR-296) - the broker watches the browser's main process.
 *
 * Which process that is: Chrome starts the native host through `cmd.exe /d /s /c "<launcher>"`
 * (measured on branded Chrome, R-330), so the broker's parent is the relay, the relay's parent the
 * launcher shell, and the first ancestor above the shell is the browser's main process. A parent
 * created after its child is a reused pid, not the parent: then the browser is not known.
 *
 * What follows from it: the browser gone ends the run at once; the relay gone with the browser
 * alive leaves 35 s for a new relay; a browser that is not known keeps the old 15 s window, so a
 * missing pid never makes the broker live longer.
 */

function table(entries: Record<number, ProcessFacts>): (pid: number) => ProcessFacts | undefined {
  return (pid) => entries[pid];
}

describe("T575 the browser's main process, found from the broker's ancestry", () => {
  it("skips the launcher shell between the relay and the browser", () => {
    const lookup = table({
      40: { parentPid: 30, exe: "node.exe", createdAt: 400n },
      30: { parentPid: 20, exe: "cmd.exe", createdAt: 300n },
      20: { parentPid: 10, exe: "chrome.exe", createdAt: 200n },
      50: { parentPid: 40, exe: "node.exe", createdAt: 500n },
    });
    expect(findBrowserAncestor(50, lookup)).toEqual({ pid: 20, createdAt: 200n });
  });

  it("takes the relay's own parent when no shell is in between, and matches the shell's name in any case", () => {
    expect(
      findBrowserAncestor(
        50,
        table({
          50: { parentPid: 40, exe: "node.exe", createdAt: 500n },
          40: { parentPid: 20, exe: "node.exe", createdAt: 400n },
          20: { parentPid: 10, exe: "msedge.exe", createdAt: 200n },
        }),
      ),
    ).toEqual({ pid: 20, createdAt: 200n });
    expect(
      findBrowserAncestor(
        50,
        table({
          50: { parentPid: 40, exe: "node.exe", createdAt: 500n },
          40: { parentPid: 30, exe: "node.exe", createdAt: 400n },
          30: { parentPid: 20, exe: "CMD.EXE", createdAt: 300n },
          20: { parentPid: 10, exe: "brave.exe", createdAt: 200n },
        }),
      ),
    ).toEqual({ pid: 20, createdAt: 200n });
  });

  it("is not known when an ancestor is gone or its pid was reused by a younger process", () => {
    expect(
      findBrowserAncestor(
        50,
        table({
          50: { parentPid: 40, exe: "node.exe", createdAt: 500n },
          40: { parentPid: 30, exe: "node.exe", createdAt: 400n },
          30: { parentPid: 20, exe: "cmd.exe", createdAt: 300n },
        }),
      ),
    ).toBeUndefined();
    expect(
      findBrowserAncestor(
        50,
        table({
          50: { parentPid: 40, exe: "node.exe", createdAt: 500n },
          40: { parentPid: 30, exe: "node.exe", createdAt: 400n },
          30: { parentPid: 20, exe: "cmd.exe", createdAt: 300n },
          20: { parentPid: 10, exe: "notepad.exe", createdAt: 350n },
        }),
      ),
    ).toBeUndefined();
    expect(findBrowserAncestor(50, table({}))).toBeUndefined();
  });
});

describe("T575 the broker's lifetime around its relay and its browser", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function lifetime(browserGone?: () => boolean) {
    const ended: string[] = [];
    const life = createBrokerLifetime({
      ...(browserGone === undefined ? {} : { browserGone }),
      end: (reason) => ended.push(reason),
      log: () => undefined,
    });
    return { life, ended };
  }

  it("ends every agent within a second of the browser going, attached or not", () => {
    let gone = false;
    const { life, ended } = lifetime(() => gone);
    vi.advanceTimersByTime(5_000);
    expect(ended).toEqual([]);

    gone = true;
    vi.advanceTimersByTime(1_000);
    expect(ended).toEqual(["browser-gone"]);
    life.stop();
  });

  it("waits up to 35 s for a new relay while the browser is alive", () => {
    const { life, ended } = lifetime(() => false);
    life.openWindow("relay-gone");
    vi.advanceTimersByTime(20_000);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(ended).toEqual(["window-expired"]);
    life.stop();
  });

  it("keeps the 15 s window when the browser is not known", () => {
    const { life, ended } = lifetime();
    life.openWindow("relay-gone");
    vi.advanceTimersByTime(14_999);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ended).toEqual(["window-expired"]);
    life.stop();
  });

  it("closes the window when a relay of the run takes the broker back, and opens it once per absence", () => {
    const { life, ended } = lifetime(() => false);
    life.openWindow("relay-gone");
    vi.advanceTimersByTime(30_000);
    life.openWindow("link-closed");
    life.closeWindow();
    vi.advanceTimersByTime(60_000);
    expect(ended).toEqual([]);
    life.stop();
  });
});
