/**
 * RTK identity mapping tests
 * Ensures stable participant IDs (userId/client_specific_id) drive join/leave and active speaker.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ConferenceSession } from "../room.ts";

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

	const joinedParticipants = new Map<string, any>();
	const rawJoined = makeEmitter();
	const joined = {
		on: rawJoined.on,
		emit: (event: string, payload?: any) => {
			if (event === "participantJoined" && payload?.id) {
				joinedParticipants.set(payload.id, payload);
			} else if (event === "participantLeft" && payload?.id) {
				joinedParticipants.delete(payload.id);
			} else if (
				(event === "videoUpdate" || event === "audioUpdate" || event === "screenShareUpdate") &&
				payload?.id
			) {
				const prev = joinedParticipants.get(payload.id) ?? { id: payload.id };
				joinedParticipants.set(payload.id, { ...prev, ...payload });
			}
			rawJoined.emit(event, payload);
		},
		values: () => joinedParticipants.values(),
		forEach: (cb: (participant: any) => void) => joinedParticipants.forEach(cb),
		setSnapshot: (participants: any[]) => {
			joinedParticipants.clear();
			for (const participant of participants) {
				if (participant?.id) {
					joinedParticipants.set(participant.id, participant);
				}
			}
		},
	};
	const participantsEmitter = makeEmitter();
	const participants = {
		joined,
		toArray: () => Array.from(joinedParticipants.values()),
		on: (event: string, handler: (payload: any) => void) =>
			participantsEmitter.on(event, handler),
		emit: (event: string, payload?: any) => participantsEmitter.emit(event, payload),
	};

	return {
		self,
		participants,
		join: mock(async () => {}),
		leave: mock(async () => {}),
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

describe("ConferenceSession (RTK identity mapping)", () => {
	let rtk: any;
	let room: ConferenceSession;

	beforeEach(() => {
		rtk = createMockRtkClient();
		room = new ConferenceSession("room_123", rtk as any, false);
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
		room.on("participant.left", (id) => {
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
		room.on("speaker.active.changed", (p) => {
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
		room.on("participant.joined", (participant) => {
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

	it("recovers remote participant from participantsUpdate snapshot when join event is missed", () => {
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

		rtk.participants.joined.setSnapshot([
			{
				id: "peer_c",
				userId: "uuid_c",
				name: "Carol",
				videoEnabled: false,
				audioEnabled: false,
			},
		]);

		let joinedId: string | null = null;
		room.on("participant.joined", (participant) => {
			joinedId = participant.id;
		});

		rtk.participants.joined.emit("participantsUpdate");

		expect(joinedId).toBe("uuid_c");
		expect(room.participants.has("uuid_c")).toBe(true);
	});

	it("recovers remote participant from participants.toArray when joined iterators are unavailable", () => {
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

		delete (rtk.participants.joined as any).values;
		delete (rtk.participants.joined as any).forEach;

		rtk.participants.joined.setSnapshot([
			{
				id: "peer_t",
				userId: "uuid_t",
				name: "Taylor",
				videoEnabled: false,
				audioEnabled: true,
			},
		]);

		let joinedId: string | null = null;
		room.on("participant.joined", (participant) => {
			joinedId = participant.id;
		});

		rtk.participants.emit("participantsUpdate");

		expect(joinedId).toBe("uuid_t");
		expect(room.participants.has("uuid_t")).toBe(true);
	});

	it("heals screen share state from participantsUpdate when screenShareUpdate is missed", () => {
		rtk.participants.joined.emit("participantJoined", {
			id: "peer_s",
			userId: "uuid_s",
			name: "Sharer",
			screenShareEnabled: false,
		});

		expect(room.participants.get("uuid_s")?.isScreenSharing).toBe(false);

		rtk.participants.joined.setSnapshot([
			{
				id: "peer_s",
				userId: "uuid_s",
				name: "Sharer",
				screenShareEnabled: true,
				screenShareTracks: {
					video: {} as any,
				},
			},
		]);

		rtk.participants.joined.emit("participantsUpdate");

		expect(room.participants.get("uuid_s")?.isScreenSharing).toBe(true);
		expect(room.participants.get("uuid_s")?.screenShareTrack).toBeTruthy();
	});

	it("heals screen share state from participants emitter updates via toArray fallback", () => {
		rtk.participants.joined.emit("participantJoined", {
			id: "peer_z",
			userId: "uuid_z",
			name: "Zara",
			screenShareEnabled: false,
		});

		delete (rtk.participants.joined as any).values;
		delete (rtk.participants.joined as any).forEach;

		rtk.participants.joined.setSnapshot([
			{
				id: "peer_z",
				userId: "uuid_z",
				name: "Zara",
				screenShareEnabled: true,
				screenShareTracks: {
					video: {} as any,
				},
			},
		]);

		rtk.participants.emit("participantsUpdate");

		expect(room.participants.get("uuid_z")?.isScreenSharing).toBe(true);
		expect(room.participants.get("uuid_z")?.screenShareTrack).toBeTruthy();
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

	it("attempts RTK reconnect when roomLeft fires unexpectedly", async () => {
		room._setStatus("connected");

		rtk.self.emit("roomLeft");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(rtk.join).toHaveBeenCalledTimes(1);
		expect(room.status).toBe("reconnecting");

		rtk.self.emit("roomJoined");
		expect(room.status).toBe("connected");
	});

	it("does not reconnect RTK when leave flow triggers roomLeft", async () => {
		room._setStatus("connected");
		rtk.leave.mockImplementation(async () => {
			rtk.self.emit("roomLeft");
		});

		await room.leave();

		expect(rtk.join).not.toHaveBeenCalled();
		expect(room.status).toBe("disconnected");
	});
});
