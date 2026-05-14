import { afterEach, describe, expect, it, vi } from "vitest";

const fetchInternalAccessTokenMock = vi.fn();
const getAccessTokenExpiryMsMock = vi.fn().mockReturnValue(null);
const createAuthenticatedRoomMock = vi.fn();

vi.mock("./internalAuth", () => ({
  fetchInternalAccessToken: fetchInternalAccessTokenMock,
  getAccessTokenExpiryMs: getAccessTokenExpiryMsMock,
}));

vi.mock("@q9labs/chalk-core", () => ({
  createAuthenticatedRoom: createAuthenticatedRoomMock,
}));

describe("createInternalMeeting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchInternalAccessTokenMock.mockReset();
    getAccessTokenExpiryMsMock.mockClear();
    getAccessTokenExpiryMsMock.mockReturnValue(null);
    createAuthenticatedRoomMock.mockReset();
  });

  it("creates a real room and returns its canonical id", async () => {
    fetchInternalAccessTokenMock.mockResolvedValue("access-123");
    createAuthenticatedRoomMock.mockResolvedValue({
      id: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      name: "New meeting",
    });

    const { createInternalMeeting } = await import("./newMeeting");
    await expect(createInternalMeeting("https://chalk-api.q9labs.ai")).resolves.toEqual({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "New meeting",
      accessToken: "access-123",
      expiresAtMs: null,
    });

    expect(fetchInternalAccessTokenMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai");
    expect(getAccessTokenExpiryMsMock).toHaveBeenCalledWith("access-123");
    expect(createAuthenticatedRoomMock).toHaveBeenCalledWith({
      apiUrl: "https://chalk-api.q9labs.ai",
      accessToken: "access-123",
      name: "New meeting",
    });
  });

  it("surfaces backend create failures", async () => {
    fetchInternalAccessTokenMock.mockResolvedValue("access-123");
    createAuthenticatedRoomMock.mockRejectedValue(new Error("failed to create room"));

    const { createInternalMeeting } = await import("./newMeeting");
    await expect(createInternalMeeting("https://chalk-api.q9labs.ai")).rejects.toThrow("failed to create room");
  });
});
