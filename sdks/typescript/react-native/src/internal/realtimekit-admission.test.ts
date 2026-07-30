import { describe, expect, it, vi } from "vitest";

import { requestRealtimeKitToken } from "./realtimekit-admission";

describe("requestRealtimeKitToken", () => {
  it("admits a participant with an encoded room path and canonical request body", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ auth_token: "rtk-token" }), { status: 201 }));

    await expect(
      requestRealtimeKitToken({
        accessToken: "participant-token",
        apiUrl: "https://api.example.test///",
        fetchImplementation,
        options: { userName: "Hasan", role: "host", metadata: { source: "mobile" } },
        roomId: "room with spaces",
      }),
    ).resolves.toBe("rtk-token");

    expect(fetchImplementation).toHaveBeenCalledWith("https://api.example.test/api/v1/rooms/room%20with%20spaces/participants", {
      method: "POST",
      headers: {
        authorization: "Bearer participant-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Hasan",
        role: "host",
        metadata: { source: "mobile" },
      }),
    });
  });

  it("accepts the camel-case token alias and rejects failed or malformed admissions", async () => {
    await expect(
      requestRealtimeKitToken({
        accessToken: "token",
        apiUrl: "https://api.example.test",
        fetchImplementation: vi.fn(async () => new Response(JSON.stringify({ authToken: "alias-token" }), { status: 200 })),
        options: { userName: "Hasan" },
        roomId: "room-1",
      }),
    ).resolves.toBe("alias-token");

    await expect(
      requestRealtimeKitToken({
        accessToken: "expired",
        apiUrl: "https://api.example.test",
        fetchImplementation: vi.fn(async () => new Response(JSON.stringify({ message: "Participant access expired" }), { status: 401 })),
        options: { userName: "Hasan" },
        roomId: "room-1",
      }),
    ).rejects.toThrow("Participant access expired");

    await expect(
      requestRealtimeKitToken({
        accessToken: "token",
        apiUrl: "https://api.example.test",
        fetchImplementation: vi.fn(async () => new Response("{}", { status: 200 })),
        options: { userName: "Hasan" },
        roomId: "room-1",
      }),
    ).rejects.toThrow("did not return a RealtimeKit token");
  });
});
