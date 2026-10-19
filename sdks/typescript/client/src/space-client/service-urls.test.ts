import { describe, expect, it } from "vitest";
import { defaultSyncUrl } from "./core";

describe("default Sync address", () => {
  it.each([
    ["https://api.example.test", "wss://sync.example.test/v1/sync"],
    ["https://nightly-api.example.test", "wss://nightly-sync.example.test/v1/sync"],
    ["https://preview-api.example.test:8443", "wss://preview-sync.example.test:8443/v1/sync"],
    ["http://api.example.test", "ws://sync.example.test/v1/sync"],
    ["http://localhost:14100", "ws://localhost:14100/v1/sync"],
    ["https://custom.example.test/prefix", "wss://custom.example.test/v1/sync"],
    ["https://apiary.example.test", "wss://apiary.example.test/v1/sync"],
  ])("routes %s to %s", (api, sync) => {
    expect(defaultSyncUrl(api)).toBe(sync);
  });
});
