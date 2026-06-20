import { afterEach, describe, expect, it, vi } from "vitest";

const exchangeJoinTokenMock = vi.fn();
const getApiUrlMock = vi.fn(() => "https://chalk-api.q9labs.ai");
const setJoinContextMock = vi.fn();

vi.mock("./webMeeting", () => ({
  exchangeJoinToken: exchangeJoinTokenMock,
  getApiUrl: getApiUrlMock,
  setJoinContext: setJoinContextMock,
}));

describe("resolveJoinLinkRedirect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    exchangeJoinTokenMock.mockReset();
    getApiUrlMock.mockClear();
    setJoinContextMock.mockClear();
  });

  it("stores join context and redirects straight to the room route", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    exchangeJoinTokenMock.mockResolvedValue({
      access_token: "access-123",
      expires_in: 900,
      room_id: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      room_name: "math-101",
    });

    const { resolveJoinLinkRedirect } = await import("../routes/j/$joinToken");

    await expect(resolveJoinLinkRedirect("join-token-123")).resolves.toBe("/room/2f0b302b-2449-43f5-ae3b-de57decb9f09?roomName=math-101");
    expect(getApiUrlMock).toHaveBeenCalledTimes(1);
    expect(exchangeJoinTokenMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai", "join-token-123");
    expect(setJoinContextMock).toHaveBeenCalledWith({
      joinToken: "join-token-123",
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
      accessToken: "access-123",
      expiresAtMs: 1_700_000_900_000,
    });

    nowSpy.mockRestore();
  });
});
