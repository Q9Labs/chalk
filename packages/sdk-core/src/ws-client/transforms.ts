import type {
	ChatMessage,
	Participant,
	Reaction,
	RoomSnapshot,
} from "../types.ts";
import type {
	ChatMessagePayload,
	ParticipantJoinedPayload,
	ParticipantPayload,
	ReactionPayload,
	RoomSnapshotPayload,
	WhiteboardCursorPayload,
	WhiteboardDataPayload,
	WhiteboardSnapshotPayload,
	PermissionChangedPayload,
	WhiteboardOpenedPayload,
	WhiteboardClosedPayload,
} from "../effect/schemas/ws-events.ts";

const toDate = (value: string | Date): Date =>
	value instanceof Date ? value : new Date(value);

export const unwrapParticipantJoined = (payload: ParticipantJoinedPayload) =>
	"participant" in payload ? payload.participant : payload;

export const toParticipant = (p: ParticipantPayload): Participant => ({
	id: p.id,
	displayName: p.displayName,
	role: p.role ?? "participant",
	isLocal: false,
	videoEnabled: p.videoEnabled ?? false,
	audioEnabled: p.audioEnabled ?? false,
	isSpeaking: p.isSpeaking ?? false,
	isScreenSharing: p.isScreenSharing ?? false,
	handRaised: p.handRaised ?? false,
	connectionQuality: p.connectionQuality ?? 100,
	joinedAt: p.joinedAt ? toDate(p.joinedAt) : undefined,
	metadata: p.metadata,
});

export const toSnapshot = (payload: RoomSnapshotPayload): RoomSnapshot => ({
	roomId: payload.roomId,
	participants: payload.participants.map(toParticipant),
	isRecording: payload.isRecording,
	recordingId: payload.recordingId,
	lastSeq: payload.lastSeq,
});

export const toChatMessage = (payload: ChatMessagePayload): ChatMessage => ({
	id: payload.id,
	senderId: payload.participantId,
	senderName: payload.displayName,
	content: payload.content,
	timestamp: new Date(payload.timestamp),
});

export const toReaction = (payload: ReactionPayload): Reaction => ({
	participantId: payload.participantId,
	participantName: payload.participantName ?? "Unknown",
	emoji: payload.emoji as Reaction["emoji"],
	timestamp: toDate(payload.timestamp),
});

export const toWhiteboardData = (payload: WhiteboardDataPayload) => ({
	...payload,
	elements: payload.elements as unknown[],
	files: payload.files as Record<string, unknown> | undefined,
	timestamp: toDate(payload.timestamp),
});

export const toWhiteboardSnapshot = (payload: WhiteboardSnapshotPayload) => ({
	...payload,
	elements: payload.elements as unknown[],
	files: payload.files as Record<string, unknown>,
	appState: payload.appState,
});

export const toWhiteboardCursor = (payload: WhiteboardCursorPayload) => ({
	...payload,
	timestamp: toDate(payload.timestamp),
});

export const toPermissionChanged = (payload: PermissionChangedPayload) => ({
	...payload,
	timestamp: toDate(payload.timestamp),
});

export const toWhiteboardOpened = (payload: WhiteboardOpenedPayload) => ({
	...payload,
	timestamp: toDate(payload.timestamp),
});

export const toWhiteboardClosed = (payload: WhiteboardClosedPayload) => ({
	...payload,
	timestamp: toDate(payload.timestamp),
});
