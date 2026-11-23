import { describe, expect, it } from "vitest";
import { isLoopbackSite } from "./loopback-site.js";

describe("043 R-582 isLoopbackSite (FR-623, D-043-5)", () => {
  it.each([
    "http://localhost:3001",
    "https://localhost",
    "http://127.0.0.1:8080",
    "http://[::1]:3000",
    // The URL parser's canonical form is 127.0.0.1, which is the origin Chrome keys the site under.
    "http://127.1",
    "http://LOCALHOST:3001",
  ])("%s is loopback", (site) => {
    expect(isLoopbackSite(site)).toBe(true);
  });

  it.each([
    "http://app.localhost",
    "http://localhost.",
    "http://127.0.0.2",
    "http://[::ffff:7f00:1]",
    "http://[::ffff:127.0.0.1]",
    "http://localhost.example.com",
    "http://127.0.0.1.nip.io",
    "https://example.com",
    "file:///x",
    "ws://localhost:3001",
    "not a url",
    "",
  ])("%s is not loopback", (site) => {
    expect(isLoopbackSite(site)).toBe(false);
  });
});
