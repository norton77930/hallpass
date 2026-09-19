import { TEST_PAGE_ALLOW_PORT, TEST_PAGE_DENY_PORT, TEST_PAGE_UNKNOWN_PORT } from "./build-config.js";

export const PAGE_FIXTURE_HOST = "127.0.0.1";

export const pageFixtureOrigins = {
  allow: `https://${PAGE_FIXTURE_HOST}:${TEST_PAGE_ALLOW_PORT}`,
  deny: `https://${PAGE_FIXTURE_HOST}:${TEST_PAGE_DENY_PORT}`,
  unknown: `https://${PAGE_FIXTURE_HOST}:${TEST_PAGE_UNKNOWN_PORT}`,
} as const;
