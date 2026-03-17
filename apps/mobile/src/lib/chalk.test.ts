import { describe, expect, it, mock } from "bun:test";
import { createNewMeetingLobbyRoute } from "./meeting-route";

describe("createMeetingLobbyRoute", () => {
  it("creates a lobby route without hitting the API", async () => {
    const randomSpy = mock(() => 0.123456);
    const originalRandom = Math.random;
    Math.random = randomSpy;

    try {
      const route = createNewMeetingLobbyRoute(randomSpy);
      expect(route.kind).toBe("lobby");
      expect(route.role).toBe("host");
      expect(route.source).toBe("new-meeting");
      expect(route.roomName).toBeDefined();
      expect(route.roomName?.length ?? 0).toBeGreaterThan(0);
      expect(route.roomId.startsWith("instant-meeting-")).toBe(true);
      expect(randomSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      Math.random = originalRandom;
    }
  });
});
