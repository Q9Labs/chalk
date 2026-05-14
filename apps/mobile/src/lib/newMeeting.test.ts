import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedMeeting } from "./newMeeting";

describe("createHostedMeeting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a real room with a host token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
        name: "Velvet Harbor",
      }),
      status: 201,
    }));

    await expect(
      createHostedMeeting(
        "https://chalk-api.q9labs.ai",
        async () => "host-access-123",
        undefined,
        () => 0,
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toEqual({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "Velvet Harbor",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://chalk-api.q9labs.ai/api/v1/rooms", {
      method: "POST",
      headers: {
        Authorization: "Bearer host-access-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Phantom Tea" }),
    });
  });

  it("surfaces backend create failures", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "failed to create room" }),
    }));

    await expect(
      createHostedMeeting(
        "https://chalk-api.q9labs.ai",
        async () => "host-access-123",
        undefined,
        () => 0,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow("failed to create room");
  });
});
