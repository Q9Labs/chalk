import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWebAccessTokenMock = vi.fn();
const getAccessTokenExpiryMsMock = vi.fn().mockReturnValue(null);
const createAuthenticatedRoomMock = vi.fn();

vi.mock("./webMeeting", () => ({
  fetchWebAccessToken: fetchWebAccessTokenMock,
  getAccessTokenExpiryMs: getAccessTokenExpiryMsMock,
}));

vi.mock("@q9labs/chalk-core", () => ({
  createAuthenticatedRoom: createAuthenticatedRoomMock,
}));

describe("createWebMeeting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchWebAccessTokenMock.mockReset();
    getAccessTokenExpiryMsMock.mockClear();
    getAccessTokenExpiryMsMock.mockReturnValue(null);
    createAuthenticatedRoomMock.mockReset();
  });

  it("creates a real room and returns its canonical id", async () => {
    fetchWebAccessTokenMock.mockResolvedValue("access-123");
    createAuthenticatedRoomMock.mockResolvedValue({
      id: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      name: "New meeting",
    });

    const { createWebMeeting } = await import("./newMeeting");
    await expect(createWebMeeting("https://chalk-api.q9labs.ai")).resolves.toEqual({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "New meeting",
      accessToken: "access-123",
      expiresAtMs: null,
    });

    expect(fetchWebAccessTokenMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai");
    expect(getAccessTokenExpiryMsMock).toHaveBeenCalledWith("access-123");
    expect(createAuthenticatedRoomMock).toHaveBeenCalledWith({
      apiUrl: "https://chalk-api.q9labs.ai",
      accessToken: "access-123",
      name: "New meeting",
    });
  });

  it("surfaces backend create failures", async () => {
    fetchWebAccessTokenMock.mockResolvedValue("access-123");
    createAuthenticatedRoomMock.mockRejectedValue(new Error("failed to create room"));

    const { createWebMeeting } = await import("./newMeeting");
    await expect(createWebMeeting("https://chalk-api.q9labs.ai")).rejects.toThrow("failed to create room");
  });
});
