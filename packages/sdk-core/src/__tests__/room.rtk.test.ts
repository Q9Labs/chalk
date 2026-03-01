/**
 * RTK identity mapping tests
 * Ensures stable participant IDs (userId/client_specific_id) drive join/leave and active speaker.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Room } from "../room.ts";

const createMockRtkClient = () => {
	const makeEmitter = () => {
		const handlers = new Map<string, Set<(payload: any) => void>>();
		return {
			on: (event: string, handler: (payload: any) => void) => {
				const set = handlers.get(event) ?? new Set();
				set.add(handler);
				handlers.set(event, set);
				return () => set.delete(handler);
			},
			emit: (event: string, payload?: any) => {
				const set = handlers.get(event);
				if (!set) return;
				for (const h of set) h(payload);
			},
		};
	};

	const self = makeEmitter();
	self.audioEnabled = true;
	self.audioTrack = {} as any;
	self.enableAudio = mock(async () => {
		self.audioEnabled = true;
		self.audioTrack = {} as any;
	});
	self.disableAudio = mock(async () => {
		self.audioEnabled = false;
		self.audioTrack = null;
	});

	const joined = makeEmitter();
	const participantsEmitter = makeEmitter();
	const participants = {
		joined,
		on: (event: string, handler: (payload: any) => void) =>
			participantsEmitter.on(event, handler),
		emit: (event: string, payload?: any) => participantsEmitter.emit(event, payload),
	};

	return {
		self,
		participants,
	};
};

const createMockWsClient = () => {
	const handlers = new Map<string, Set<(payload: any) => void>>();
	return {
		on: (event: string, handler: (payload: any) => void) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit: (event: string, payload?: any) => {
			const set = handlers.get(event);
			if (!set) return;
			for (const h of set) h(payload);
		},
		muteParticipant: mock(() => {}),
		unmuteParticipant: mock(() => {}),
	};
};

describe("Room (RTK identity mapping)", () => {
	let rtk: any;
	let room: Room;

	beforeEach(() => {
		rtk = createMockRtkClient();
		room = new Room("room_123", rtk as any, false);
	});

	it("does not duplicate local participant when RTK includes self in participantJoined", () => {
		room._setLocalParticipant({
			id: "uuid_local",
			userId: "uuid_local",
			displayName: "Me",
			role: "participant",
			isLocal: true,
			videoEnabled: false,
			audioEnabled: false,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
		});

		rtk.participants.joined.emit("participantJoined", {
			id: "peer_self",
			userId: "uuid_local",
			name: "Me",
		});

		expect(room.participants.size).toBe(1);
		expect(room.participants.get("uuid_local")?.isLocal).toBe(true);
	});

	it("removes remote participant on participantLeft using stable userId", () => {
		room._setLocalParticipant({
			id: "uuid_local",
			userId: "uuid_local",
			displayName: "Me",
			role: "participant",
			isLocal: true,
			videoEnabled: false,
			audioEnabled: false,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
		});

		rtk.participants.joined.emit("participantJoined", {
			id: "peer_a",
			userId: "uuid_a",
			name: "Alice",
		});

		expect(room.participants.has("uuid_a")).toBe(true);

		let leftId: string | null = null;
		room.on("participant-left", (id) => {
			leftId = id;
		});

		rtk.participants.joined.emit("participantLeft", {
			id: "peer_a",
			userId: "uuid_a",
		});

		expect(leftId).toBe("uuid_a");
		expect(room.participants.has("uuid_a")).toBe(false);
	});

	it("maps activeSpeakerChanged to stable participant id", () => {
		rtk.participants.joined.emit("participantJoined", {
			id: "peer_a",
			userId: "uuid_a",
			name: "Alice",
		});

		let emitted: any = null;
		room.on("active-speaker-changed", (p) => {
			emitted = p;
		});

		rtk.participants.emit("activeSpeakerChanged", {
			id: "peer_a",
			userId: "uuid_a",
		});

		expect(room.activeSpeaker?.id).toBe("uuid_a");
		expect(emitted?.id).toBe("uuid_a");
	});

	it("uses peerId->stableId mapping when update payloads omit userId", () => {
		rtk.participants.joined.emit("participantJoined", {
			id: "peer_a",
			userId: "uuid_a",
			name: "Alice",
			videoEnabled: false,
		});

		rtk.participants.joined.emit("videoUpdate", {
			id: "peer_a",
			// no userId
			videoEnabled: true,
			videoTrack: {} as any,
		});

		expect(room.participants.get("uuid_a")?.videoEnabled).toBe(true);
	});

	it("recovers remote participant from update events when participantJoined is missed", () => {
		room._setLocalParticipant({
			id: "uuid_local",
			userId: "uuid_local",
			displayName: "Me",
			role: "participant",
			isLocal: true,
			videoEnabled: false,
			audioEnabled: false,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
		});

		let joinedId: string | null = null;
		room.on("participant-joined", (participant) => {
			joinedId = participant.id;
		});

		// Simulate dropped "participantJoined" event; only media update arrives.
		rtk.participants.joined.emit("videoUpdate", {
			id: "peer_b",
			userId: "uuid_b",
			name: "Bob",
			videoEnabled: true,
			videoTrack: {} as any,
		});

		expect(joinedId).toBe("uuid_b");
		expect(room.participants.has("uuid_b")).toBe(true);
		expect(room.participants.get("uuid_b")?.videoEnabled).toBe(true);
	});

	it("applies host mute/unmute commands to local audio when addressed to local participant", async () => {
		const ws = createMockWsClient();
		room.attachWsClient(ws as any);

		room._setLocalParticipant({
			id: "uuid_local",
			userId: "uuid_local",
			displayName: "Me",
			role: "participant",
			isLocal: true,
			videoEnabled: false,
			audioEnabled: true,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
		});

		ws.emit("participant.mute", { participantId: "uuid_local" });
		await new Promise((r) => setTimeout(r, 0));

		expect(rtk.self.disableAudio).toHaveBeenCalled();
		expect(room.localParticipant?.audioEnabled).toBe(false);

		ws.emit("participant.unmute", { participantId: "uuid_local" });
		await new Promise((r) => setTimeout(r, 0));

		expect(rtk.self.enableAudio).toHaveBeenCalled();
		expect(room.localParticipant?.audioEnabled).toBe(true);
	});

	it("sends mute/unmute commands over WS when local participant is host", () => {
		const ws = createMockWsClient();
		room.attachWsClient(ws as any);

		room._setLocalParticipant({
			id: "uuid_host",
			userId: "uuid_host",
			displayName: "Host",
			role: "host",
			isLocal: true,
			videoEnabled: false,
			audioEnabled: true,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
		});

		room.muteParticipant("uuid_a");
		room.unmuteParticipant("uuid_a");

		expect(ws.muteParticipant).toHaveBeenCalledWith("uuid_a");
		expect(ws.unmuteParticipant).toHaveBeenCalledWith("uuid_a");
	});
});
