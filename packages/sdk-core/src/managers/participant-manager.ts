/**
 * Participant manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import type { Room } from "../room";
import { StateContainer } from "../state/state-container";
import type { Participant } from "../types";
import { createLogger, type Logger } from "../utils/logger";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Participant manager state */
export interface ParticipantState {
	/** All participants (including local) */
	readonly participants: readonly Participant[];
	/** Current active speaker */
	readonly activeSpeaker: Participant | null;
	/** Local participant */
	readonly localParticipant: Participant | null;
	/** Total participant count */
	readonly count: number;
}

/** Participant manager events */
export interface ParticipantManagerEvents {
	/** Participant joined the room */
	"participant:joined": { participant: Participant };
	/** Participant left the room */
	"participant:left": { participantId: string };
	/** Participant state updated */
	"participant:updated": { participantId: string; participant: Participant };
	/** Active speaker changed */
	"active-speaker:changed": { participant: Participant | null };
}

/**
 * Manages participant list and active speaker detection
 */
export class ParticipantManager extends StateContainer<ParticipantState> {
	private readonly events = new TypedEventEmitter<ParticipantManagerEvents>();
	private readonly log: Logger = createLogger("Participants");
	private room: Room | null = null;
	private participantMap = new Map<string, Participant>();

	constructor(_debug = false) {
		super({
			participants: [],
			activeSpeaker: null,
			localParticipant: null,
			count: 0,
		});
	}

	/** Subscribe to participant events */
	on<K extends keyof ParticipantManagerEvents>(
		event: K,
		handler: (data: ParticipantManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach Room instance and set up listeners */
	attachRoom(room: Room): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncFromRoom();
	}

	private syncFromRoom(): void {
		if (!this.room) return;

		this.participantMap.clear();

		// Add all participants from room
		for (const [id, participant] of this.room.participants) {
			this.participantMap.set(id, this.normalizeParticipant(participant));
		}

		// Add local participant
		if (this.room.localParticipant) {
			const local = this.normalizeParticipant(this.room.localParticipant);
			this.participantMap.set(local.id, local);
		}

		this.updateState();
	}

	private normalizeParticipant(p: Participant): Participant {
		// Legacy Participant type uses videoEnabled/audioEnabled/handRaised
		return {
			...p,
			videoTrack: p.videoTrack ?? undefined,
			audioTrack: p.audioTrack ?? undefined,
			screenShareTrack: p.screenShareTrack ?? undefined,
			screenShareAudioTrack: p.screenShareAudioTrack ?? undefined,
			videoEnabled: p.videoEnabled ?? false,
			audioEnabled: p.audioEnabled ?? false,
			isScreenSharing: p.isScreenSharing ?? false,
			isSpeaking: p.isSpeaking ?? false,
			handRaised: p.handRaised ?? false,
			connectionQuality: p.connectionQuality ?? 100,
		};
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("participant-joined", (participant) => {
			const normalized = this.normalizeParticipant(participant);
			this.participantMap.set(normalized.id, normalized);
			this.updateState();
			this.log.info("Joined", { participantId: normalized.id, displayName: normalized.displayName });
			this.events.emit("participant:joined", { participant: normalized });
		});

		this.room.on("participant-left", (participantId) => {
			const p = this.participantMap.get(participantId);
			this.participantMap.delete(participantId);
			this.updateState();
			this.log.info("Left", { participantId, displayName: p?.displayName });
			this.events.emit("participant:left", { participantId });
		});

		this.room.on("participant-updated", ({ participantId, participant }) => {
			const normalized = this.normalizeParticipant(participant);
			this.participantMap.set(participantId, normalized);
			this.updateState();
			this.log.debug("Updated", { participantId, displayName: normalized.displayName });
			this.events.emit("participant:updated", {
				participantId,
				participant: normalized,
			});
		});

		this.room.on("active-speaker-changed", (speaker) => {
			const normalized = speaker ? this.normalizeParticipant(speaker) : null;
			this.setState({ activeSpeaker: normalized });
			this.log.debug("Active speaker", { displayName: normalized?.displayName ?? null });
			this.events.emit("active-speaker:changed", { participant: normalized });
		});
	}

	private updateState(): void {
		const participants = Array.from(this.participantMap.values());
		const localParticipant = participants.find((p) => p.isLocal) ?? null;

		this.setState({
			participants,
			localParticipant,
			count: participants.length,
		});
	}

	/** Get participant by ID */
	getParticipant(id: string): Participant | undefined {
		return this.participantMap.get(id);
	}

	/** Get remote participants (excludes local) */
	get remoteParticipants(): readonly Participant[] {
		return this.getState().participants.filter((p) => !p.isLocal);
	}

	/** Cleanup resources */
	dispose(): void {
		this.participantMap.clear();
		this.events.removeAllListeners();
	}
}
