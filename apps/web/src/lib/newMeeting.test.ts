import { afterEach, describe, expect, it, vi } from "vitest";

const fetchInternalAccessTokenMock = vi.fn();

vi.mock("./internalAuth", () => ({
  fetchInternalAccessToken: fetchInternalAccessTokenMock,
}));

describe("createInternalMeeting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchInternalAccessTokenMock.mockReset();
  });

  it("creates a real room and returns its canonical id", async () => {
    fetchInternalAccessTokenMock.mockResolvedValue("access-123");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
        name: "New meeting",
      }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const { createInternalMeeting } = await import("./newMeeting");
    await expect(createInternalMeeting("https://chalk-api.q9labs.ai")).resolves.toEqual({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "New meeting",
      accessToken: "access-123",
      expiresAtMs: null,
    });

    expect(fetchInternalAccessTokenMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai");
    expect(fetchMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai/api/v1/rooms", {
      method: "POST",
      headers: {
        Authorization: "Bearer access-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "New meeting" }),
    });
  });

  it("surfaces backend create failures", async () => {
    fetchInternalAccessTokenMock.mockResolvedValue("access-123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "failed to create room" }),
    } as Response);

    const { createInternalMeeting } = await import("./newMeeting");
    await expect(createInternalMeeting("https://chalk-api.q9labs.ai")).rejects.toThrow("failed to create room");
  });
});
