import { describe, expect, it } from "bun:test";
import { createRoom, createSession, scheduleRoom } from "../conference-client/client-room-ops.ts";

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
});
