import { describe, expect, it } from "vitest";
import { directOrigin } from "./direct-path";
import * as apiUrls from "./api-urls";
import { defaultSyncUrl, directSyncUrl, normalizeBaseUrl, trimTrailingSlashes, whiteboardUrl } from "./urls";

describe("default Sync address", () => {
  it.each([
    ["https://api.example.test", "wss://sync.example.test/v1/sync"],
    ["https://nightly-api.chalkmeet.com", "wss://nightly-sync.chalkmeet.com/v1/sync"],
    ["https://api.chalkmeet.com", "wss://sync.chalkmeet.com/v1/sync"],
    ["https://chalkmeet.com", "wss://chalkmeet.com/v1/sync"],
    ["https://customer-api.example.com:8443/proxy", "wss://customer-api.example.com:8443/v1/sync"],
    ["https://nightly-api.chalkmeet.com.evil.test", "wss://nightly-api.chalkmeet.com.evil.test/v1/sync"],
    ["https://nightly-api.notchalkmeet.com", "wss://nightly-api.notchalkmeet.com/v1/sync"],
    ["https://preview-api.chalkmeet.com:8443", "wss://preview-sync.chalkmeet.com:8443/v1/sync"],
    ["https://nightly-api.eu.chalkmeet.com", "wss://nightly-sync.eu.chalkmeet.com/v1/sync"],
    ["https://nightly-api.example.test", "wss://nightly-api.example.test/v1/sync"],
    ["http://api.example.test", "ws://sync.example.test/v1/sync"],
    ["http://localhost:14100", "ws://localhost:14100/v1/sync"],
    ["https://custom.example.test/prefix", "wss://custom.example.test/v1/sync"],
    ["https://apiary.example.test", "wss://apiary.example.test/v1/sync"],
    ["https://api.example.test/proxy?source=mobile#config", "wss://sync.example.test/v1/sync"],
  ])("routes %s to %s", (api, sync) => {
    expect(defaultSyncUrl(api)).toBe(sync);
  });
});

it("derives the direct Sync URL on the host a grant advertises", () => {
  const origin = directOrigin("https://direct.example.test");
  expect(origin && directSyncUrl(origin)).toBe("wss://direct.example.test/v1/sync");
});

it("derives the Whiteboard URL from the Sync URL", () => {
  expect(whiteboardUrl("wss://sync.example.test/v1/sync?x=1")).toBe("wss://sync.example.test/v1/whiteboard");
});

it("keeps one base URL shape for every hand-built route", () => {
  expect(normalizeBaseUrl("https://api.example.test/proxy///?a=1#b")).toBe("https://api.example.test/proxy");
  const subject = { tenantId: "t 1", spaceId: "s", episodeId: "e", participantId: "p" };
  expect(apiUrls.episodeStatus("https://api.example.test/", subject)).toBe("https://api.example.test/v1/tenants/t%201/spaces/s/episodes/e/participants/p/episode-status");
  expect(apiUrls.chatAttachmentDownload("https://api.example.test//", "a/b")).toBe("https://api.example.test/v1/chat/attachments/a%2Fb/download");
});

describe("trimTrailingSlashes", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["////", ""],
    ["https://api.example.test", "https://api.example.test"],
    ["https://api.example.test/", "https://api.example.test"],
    ["https://api.example.test/v1///", "https://api.example.test/v1"],
    ["a//b/", "a//b"],
  ])("trims %j to %j", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it("takes linear time on a long run of slashes that does not end the input", () => {
    const input = `${"/".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
