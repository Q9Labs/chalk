import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { describe, expect, it } from "vitest";
import { createLocalSpaceClient } from "./local-space-client";

// The factory throws once it has seen the platform, so the test needs no client double.
function platformFor(credential: { readonly syncURL: string; readonly syncDirectURL?: string; readonly directPath?: "off" }): SpaceClientPlatform {
  let seen: SpaceClientPlatform | undefined;
  expect(() =>
    createLocalSpaceClient(
      { credential: { apiBaseURL: "https://api.example.test", space: "design-lab", ...credential }, getAccess: () => Promise.reject(new Error("unused")) },
      {
        createSpaceClient: (_options, platform) => {
          seen = platform;
          throw new Error("platform captured");
        },
      },
    ),
  ).toThrow("platform captured");
  if (!seen) throw new Error("the Space client factory was not called");
  return seen;
}

describe("local Space client direct Sync path", () => {
  it("passes no direct URL unless the credential carries one", () => {
    expect(platformFor({ syncURL: "wss://sync.example.test/v1/sync" })).toEqual({ syncUrl: "wss://sync.example.test/v1/sync" });
  });

  it("passes the direct URL next to the Tunnel URL when configured", () => {
    expect(platformFor({ syncURL: "wss://sync.example.test/v1/sync", syncDirectURL: "wss://direct.example.test/v1/sync" })).toEqual({
      syncUrl: "wss://sync.example.test/v1/sync",
      syncDirectUrl: "wss://direct.example.test/v1/sync",
    });
  });

  it("passes the control-arm switch so the SDK keeps every call on the Tunnel", () => {
    expect(platformFor({ syncURL: "wss://sync.example.test/v1/sync", directPath: "off" })).toEqual({ syncUrl: "wss://sync.example.test/v1/sync", directPath: "off" });
  });
});
