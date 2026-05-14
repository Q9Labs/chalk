import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthenticatedRoom, getRoomJoinAvailability } from "../room-primitives.ts";

describe("room-primitives", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("getRoomJoinAvailability", () => {
    it("returns open for rooms without schedule metadata", () => {
      const availability = getRoomJoinAvailability({
        id: "room_1",
      });

      expect(availability).toEqual({
        kind: "open",
        isJoinAllowed: true,
        startsAtMs: null,
        opensAtMs: null,
        remainingMs: null,
      });
    });

    it("returns not_yet_open using snake_case schedule fields", () => {
      const startIso = "2026-04-14T10:00:00.000Z";
      const nowMs = Date.parse("2026-04-14T09:40:00.000Z");

      const availability = getRoomJoinAvailability(
        {
          scheduled_start_at: startIso,
          allow_early_join_minutes: 15,
        },
        nowMs,
      );

      expect(availability.kind).toBe("not_yet_open");
      expect(availability.isJoinAllowed).toBe(false);
      expect(availability.startsAtMs).toBe(Date.parse(startIso));
      expect(availability.opensAtMs).toBe(Date.parse("2026-04-14T09:45:00.000Z"));
      expect(availability.remainingMs).toBe(5 * 60_000);
    });

    it("returns scheduled when a scheduled room is already open for joins", () => {
      const startIso = "2026-04-14T10:00:00.000Z";
      const nowMs = Date.parse("2026-04-14T09:50:00.000Z");

      const availability = getRoomJoinAvailability(
        {
          scheduledStartAt: startIso,
          allowEarlyJoinMinutes: 15,
        },
        nowMs,
      );

      expect(availability).toEqual({
        kind: "scheduled",
        isJoinAllowed: true,
        startsAtMs: Date.parse(startIso),
        opensAtMs: Date.parse("2026-04-14T09:45:00.000Z"),
        remainingMs: null,
      });
    });

    it("supports nested room.schedule metadata fields", () => {
      const availability = getRoomJoinAvailability(
        {
          schedule: {
            scheduled_start_at: "2026-04-14T11:00:00.000Z",
            allow_early_join_minutes: 10,
          },
        },
        Date.parse("2026-04-14T10:55:00.000Z"),
      );

      expect(availability.kind).toBe("scheduled");
      expect(availability.isJoinAllowed).toBe(true);
      expect(availability.opensAtMs).toBe(Date.parse("2026-04-14T10:50:00.000Z"));
    });

    it("treats invalid schedule timestamps as open", () => {
      const availability = getRoomJoinAvailability({
        scheduled_start_at: "not-a-date",
        allow_early_join_minutes: 30,
      });

      expect(availability.kind).toBe("open");
      expect(availability.isJoinAllowed).toBe(true);
      expect(availability.startsAtMs).toBeNull();
      expect(availability.opensAtMs).toBeNull();
    });
  });

  describe("createAuthenticatedRoom", () => {
    it("creates a room using APIClient normalization and returns a RoomResource", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            room_id: "room_uuid_1",
            tenant_id: "tenant_1",
            cloudflare_meeting_id: "cf_meeting_1",
            name: "Team Sync",
            config: { chat_enabled: true },
            status: "active",
            allow_early_join_minutes: 5,
            created_at: "2026-04-14T10:00:00.000Z",
            updated_at: "2026-04-14T10:00:00.000Z",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      vi.stubGlobal("fetch", fetchMock);

      const room = await createAuthenticatedRoom({
        apiUrl: "https://api.chalk.test",
        accessToken: "jwt_test_token",
        name: "Team Sync",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.chalk.test/api/v1/rooms");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer jwt_test_token",
      });
      expect(JSON.parse(String(init.body))).toEqual({
        name: "Team Sync",
      });

      expect(room.id).toBe("room_uuid_1");
      expect(room.allowEarlyJoinMinutes).toBe(5);
      expect(room.status).toBe("active");
    });

    it("throws when apiUrl is empty", async () => {
      await expect(
        createAuthenticatedRoom({
          apiUrl: "   ",
          accessToken: "jwt_test_token",
          name: "Team Sync",
        }),
      ).rejects.toThrow("apiUrl is required");
    });

    it("throws when accessToken is empty", async () => {
      await expect(
        createAuthenticatedRoom({
          apiUrl: "https://api.chalk.test",
          accessToken: "   ",
          name: "Team Sync",
        }),
      ).rejects.toThrow("accessToken is required");
    });

    it("surfaces API failure messages from the shared SDK request path", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "invalid token",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        createAuthenticatedRoom({
          apiUrl: "https://api.chalk.test",
          accessToken: "jwt_expired",
          name: "Team Sync",
        }),
      ).rejects.toThrow("invalid token");
    });
  });
});
