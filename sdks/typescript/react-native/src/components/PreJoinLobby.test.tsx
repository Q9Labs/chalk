import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./PreJoinLobby.android", () => ({ PreJoinLobbyAndroid: () => null }));
vi.mock("./PreJoinLobby.ios-pad", () => ({ PreJoinLobbyIosPad: () => null }));
vi.mock("./PreJoinLobby.ios-phone", () => ({ PreJoinLobbyIosPhone: () => null }));
vi.mock("./PreJoinLobby.macos", () => ({ PreJoinLobbyMacos: () => null }));

describe("PreJoinLobby", () => {
  it("selects the platform-specific pre-join lobby", async () => {
    const { PreJoinLobby } = await import("./PreJoinLobby");

    expect(PreJoinLobby({ roomName: "Room", onJoin: vi.fn() })).toBeTruthy();
  });
});
