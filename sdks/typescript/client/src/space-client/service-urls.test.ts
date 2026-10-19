import { describe, expect, it } from "vitest";
import { defaultSyncUrl } from "./core";

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
  ])("routes %s to %s", (api, sync) => {
    expect(defaultSyncUrl(api)).toBe(sync);
  });
});
