// WebSocket message types matching apps/api/internal/interfaces/websocket/messages.go
export const MessageType = {
	// Client → Server
	CHAT_SEND: "chat.send",
	REACTION_SEND: "reaction.send",
	HAND_RAISE: "hand.raise",
	HAND_LOWER: "hand.lower",
	PONG: "pong",
	WHITEBOARD_UPDATE: "whiteboard.update",
	ROOM_SYNC: "room.sync",

	// Server → Client
	CONNECTED: "connected",
	PARTICIPANT_JOINED: "participant.joined",
	PARTICIPANT_LEFT: "participant.left",
	CHAT_MESSAGE: "chat.message",
	ROOM_SNAPSHOT: "room.snapshot",
	PING: "ping",
	ERROR: "error",
};

export function createMessage(type, payload) {
	return JSON.stringify({ type, payload });
}

export function chatMessage(content) {
	return createMessage(MessageType.CHAT_SEND, { content });
}

export function reaction(emoji) {
	return createMessage(MessageType.REACTION_SEND, { emoji });
}

export function pong() {
	return createMessage(MessageType.PONG, {
		timestamp: new Date().toISOString(),
	});
}
