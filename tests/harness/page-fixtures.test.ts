import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_PAGE_ALLOW_PORT, TEST_PAGE_UNKNOWN_PORT } from "../../packages/test-kit/dist/build-config.js";
import { handle } from "./page-fixtures.js";

/**
 * 030/T885 - the frame fixtures the consent-per-site gates stand on. Each page is served, and each of
 * its frames comes from the origin the story needs: the second site (a real out-of-process frame),
 * the top site, or no network source at all (`srcdoc`, `about:blank`).
 *
 * The pages are served over plain HTTP here (the handler is the one the TLS servers use), so the
 * origins asserted are the ones written into the markup for the allow port.
 */

const TOP = `https://127.0.0.1:${TEST_PAGE_ALLOW_PORT}`;
const SECOND_SITE = `https://localhost:${TEST_PAGE_ALLOW_PORT}`;
const SIBLING = `https://127.0.0.1:${TEST_PAGE_UNKNOWN_PORT}`;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => handle(TEST_PAGE_ALLOW_PORT, request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

async function served(name: string): Promise<string> {
  const response = await fetch(`${base}/${name}`);
  expect(response.status, `/${name} is served`).toBe(200);
  return response.text();
}

type Frame = Record<string, string>;

/** The `<iframe>` tags of a page with their attributes (quoted values may contain `>`). */
function frames(html: string): Frame[] {
  const found: Frame[] = [];
  for (const tag of html.matchAll(/<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attributes: Frame = {};
    for (const attribute of (tag[1] ?? "").matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      attributes[attribute[1] as string] = attribute[2] ?? "";
    }
    found.push(attributes);
  }
  return found;
}

function only(html: string): Frame {
  const all = frames(html);
  expect(all).toHaveLength(1);
  return all[0] as Frame;
}

/** The origin a frame source resolves to when the page is on the top site. */
function originOf(source: string | undefined): string {
  return new URL(source ?? "", `${TOP}/`).origin;
}

describe("T885 frame fixtures", () => {
  it("frame-consent: one frame from the second site, with a stable id, title and size", async () => {
    const page = await served("frame-consent");
    expect(page).toContain('id="top-heading"');
    const frame = only(page);
    expect(frame["id"]).toBe("consent-frame");
    expect(frame["title"]).toBeTruthy();
    expect(frame["width"]).toBeTruthy();
    expect(frame["height"]).toBeTruthy();
    expect(originOf(frame["src"])).toBe(SECOND_SITE);

    const child = await served(new URL(frame["src"] as string).pathname.slice(1));
    expect(child).toContain('id="frame-field"');
    expect(child).toContain('<label for="frame-field">');
    expect(child).toContain('id="frame-button"');
    expect(child).toContain("'clicked'");
    expect(child).toContain('id="frame-status"');
  });

  it("frame-sandboxed: a frame on the top site that is sandboxed without allow-same-origin", async () => {
    const frame = only(await served("frame-sandboxed"));
    expect(frame["id"]).toBe("sandboxed-frame");
    expect(frame["sandbox"]).toBe("allow-scripts");
    expect(originOf(frame["src"])).toBe(TOP);

    const child = await served(new URL(frame["src"] as string, `${TOP}/`).pathname.slice(1));
    expect(child).toContain('id="frame-field"');
    expect(child).toContain('id="frame-button"');
  });

  it("frame-srcdoc: a srcdoc frame with no src, holding a field and a button", async () => {
    const frame = only(await served("frame-srcdoc"));
    expect(frame["id"]).toBe("srcdoc-frame");
    expect(frame["src"]).toBeUndefined();
    expect(frame["sandbox"]).toBeUndefined();
    expect(frame["srcdoc"]).toContain("frame-field");
    expect(frame["srcdoc"]).toContain("frame-button");
  });

  it("frame-blank: an about:blank frame the parent fills with script", async () => {
    const page = await served("frame-blank");
    const frame = only(page);
    expect(frame["id"]).toBe("blank-frame");
    expect(frame["src"]).toBe("about:blank");
    expect(page).toContain("contentDocument");
    expect(page).toContain("frame-field");
    expect(page).toContain("frame-button");
  });

  it("frame-nested: a same-site frame that holds a frame from the second site", async () => {
    const outer = only(await served("frame-nested"));
    expect(outer["id"]).toBe("mid-frame");
    expect(originOf(outer["src"])).toBe(TOP);

    const middle = await served(new URL(outer["src"] as string, `${TOP}/`).pathname.slice(1));
    const inner = only(middle);
    expect(inner["id"]).toBe("inner-frame");
    expect(originOf(inner["src"])).toBe(SECOND_SITE);
    expect(inner["src"]).toMatch(/^https:\/\/localhost:/);
  });

  it("frame-navigating: a second-site frame that moves to a third origin on postMessage go", async () => {
    const page = await served("frame-navigating");
    const frame = only(page);
    expect(frame["id"]).toBe("moving-frame");
    expect(originOf(frame["src"])).toBe(SECOND_SITE);
    expect(page).toContain('addEventListener("message"');
    expect(page).toContain('"go"');

    const target = /\.src\s*=\s*"([^"]+)"/.exec(page)?.[1];
    expect(target).toBeTruthy();
    const targetOrigin = originOf(target);
    expect(targetOrigin).toBe(SIBLING);
    expect(targetOrigin).not.toBe(TOP);
    expect(targetOrigin).not.toBe(SECOND_SITE);

    const moved = await served(new URL(target as string).pathname.slice(1));
    expect(moved).toContain('id="frame-field"');
  });
});
