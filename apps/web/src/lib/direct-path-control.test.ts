import { afterEach, describe, expect, it, vi } from "vitest";
import { publicDirectPathControl, publicSyncDirectURL } from "./chalk-access";

afterEach(() => vi.unstubAllGlobals());

describe("control arm switch", () => {
  it("is off by default and set by ?direct=off", () => {
    vi.stubGlobal("location", { search: "" });
    expect(publicDirectPathControl()).toEqual({});
    vi.stubGlobal("location", { search: "?direct=off" });
    expect(publicDirectPathControl()).toEqual({ directPath: "off" });
  });

  it("also drops the static direct Sync URL, which the lobby warm socket and the owner call read", () => {
    vi.stubEnv("VITE_CHALK_SYNC_DIRECT_URL", "wss://direct.example.test/v1/sync");
    vi.stubGlobal("location", { search: "" });
    expect(publicSyncDirectURL()).toEqual({ syncDirectURL: "wss://direct.example.test/v1/sync" });
    vi.stubGlobal("location", { search: "?direct=off" });
    expect(publicSyncDirectURL()).toEqual({});
    vi.unstubAllEnvs();
  });
});
