import { describe, expect, it } from "bun:test";
import { createJoinToken, createRoom, createSession, exchangeJoinToken, listRooms, scheduleRoom } from "../conference-client/client-room-ops.ts";

describe("client-room-ops", () => {
	it("createSession returns id when API returns Room payload", async () => {
		const apiClient = {
			createSession: async () => ({
				success: true,
				data: {
					id: "room_uuid_1",
					status: "active",
				},
			}),
		};

		await expect(createSession(apiClient as any)).resolves.toBe("room_uuid_1");
	});

	it("createSession throws when room id is missing", async () => {
		const apiClient = {
			createSession: async () => ({
				success: true,
				data: {
					status: "active",
				},
			}),
		};

		await expect(createSession(apiClient as any)).rejects.toThrow(
			"Missing room ID in create room response",
		);
	});

	it("createRoom returns normalized room resource", async () => {
		const apiClient = {
			createRoom: async () => ({
				success: true,
				data: {
					id: "room_uuid_2",
					status: "active",
				},
			}),
		};

		await expect(createRoom(apiClient as any, { name: "Math" })).resolves.toMatchObject({
			id: "room_uuid_2",
			status: "active",
		});
	});

	it("scheduleRoom returns scheduled resource", async () => {
		const apiClient = {
			scheduleRoom: async () => ({
				success: true,
				data: {
					id: "room_uuid_3",
					status: "scheduled",
				},
			}),
		};

		await expect(
			scheduleRoom(apiClient as any, {
				name: "Physics",
				scheduledStartAt: "2026-03-10T14:00:00Z",
			}),
		).resolves.toMatchObject({
			id: "room_uuid_3",
			status: "scheduled",
		});
	});

	it("listRooms returns typed room list payload", async () => {
		const apiClient = {
			listRooms: async () => ({
				success: true,
				data: {
					rooms: [{ id: "room_uuid_4", status: "scheduled" }],
					total: 1,
					limit: 20,
					offset: 0,
				},
			}),
		};

		await expect(
			listRooms(apiClient as any, { status: ["scheduled"] }),
		).resolves.toMatchObject({
			total: 1,
			rooms: [{ id: "room_uuid_4", status: "scheduled" }],
		});
	});

	it("createJoinToken returns join token payload", async () => {
		const apiClient = {
			createJoinToken: async () => ({
				success: true,
				data: { joinToken: "tok_123" },
			}),
		};

		await expect(createJoinToken(apiClient as any, "room_uuid_5")).resolves.toEqual({
			joinToken: "tok_123",
		});
	});

	it("exchangeJoinToken returns access token payload", async () => {
		const apiClient = {
			exchangeJoinToken: async () => ({
				success: true,
				data: {
					accessToken: "jwt_123",
					expiresIn: 900,
					roomName: "room_uuid_6",
				},
			}),
		};

		await expect(exchangeJoinToken(apiClient as any, "tok_abc")).resolves.toMatchObject({
			accessToken: "jwt_123",
			roomName: "room_uuid_6",
		});
	});
});
