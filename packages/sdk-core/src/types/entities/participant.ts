/**
 * Participant entity types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

/**
 * Role of a participant in the room
 */
export type ParticipantRole = "host" | "participant";

/**
 * Connection quality indicator (0 = none, 4 = excellent)
 */
export type ConnectionQuality = 0 | 1 | 2 | 3 | 4;

/**
 * Represents a participant in a video conferencing room
 *
 * Combined array approach: local and remote participants in one list,
 * differentiated by `isLocal` flag.
 *
 * @example
 * ```ts
 * const localParticipant = participants.find(p => p.isLocal);
 * const remoteParticipants = participants.filter(p => !p.isLocal);
 * ```
 */
export interface Participant {
	/** Unique participant identifier (UUID) */
	readonly id: string;

	/** Display name shown to other participants */
	displayName: string;

	/** Avatar URL for profile picture */
	avatarUrl?: string;

	/** Role in the room */
	role: ParticipantRole;

	/** Whether this is the local (current user's) participant */
	readonly isLocal: boolean;

	// Media state
	/** Video MediaStreamTrack if publishing */
	videoTrack: MediaStreamTrack | null;

	/** Audio MediaStreamTrack if publishing */
	audioTrack: MediaStreamTrack | null;

	/** Screen share video MediaStreamTrack */
	screenShareTrack: MediaStreamTrack | null;

	/** Screen share audio MediaStreamTrack (browser support varies) */
	screenShareAudioTrack: MediaStreamTrack | null;

	/** Whether video is enabled and publishing */
	isVideoEnabled: boolean;

	/** Whether audio is enabled (not muted) */
	isAudioEnabled: boolean;

	/** Whether currently sharing screen */
	isScreenSharing: boolean;

	// Status
	/** Currently speaking (voice activity detected) */
	isSpeaking: boolean;

	/** Hand raised to speak */
	isHandRaised: boolean;

	/** Connection quality score */
	connectionQuality: ConnectionQuality;

	// Timestamps
	/** When the participant joined the room */
	joinedAt: Date;

	/** Custom metadata attached to participant */
	metadata?: Record<string, unknown>;
}

/**
 * Minimal participant info from server (before media tracks attached)
 */
export interface ParticipantInfo {
	readonly id: string;
	displayName: string;
	role: ParticipantRole;
	isActive: boolean;
	joinedAt: Date;
}
