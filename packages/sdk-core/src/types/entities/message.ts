/**
 * Chat message entity types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

/**
 * Reaction on a chat message
 */
export interface MessageReaction {
	/** Emoji character */
	emoji: string;

	/** Participant IDs who reacted with this emoji */
	participantIds: string[];
}

/**
 * Chat message in a room
 *
 * Chat is ephemeral - messages are cleared when the meeting ends.
 *
 * @example
 * ```ts
 * session.chat.on('message', ({ message }) => {
 *   console.log(`${message.senderName}: ${message.content}`);
 * });
 * ```
 */
export interface ChatMessage {
	/** Unique message identifier (UUID) */
	readonly id: string;

	/** Message content (plain text) */
	content: string;

	/** Participant ID of the sender */
	senderId: string;

	/** Display name of the sender */
	senderName: string;

	/** When the message was sent */
	timestamp: Date;

	/** Emoji reactions on this message */
	reactions: MessageReaction[];
}

/**
 * Emoji reaction sent by a participant (floating reaction, not on a message)
 */
export interface Reaction {
	/** Participant ID who sent the reaction */
	participantId: string;

	/** Display name of the participant */
	participantName: string;

	/** Emoji character */
	emoji: string;

	/** When the reaction was sent */
	timestamp: Date;
}

/**
 * Available reaction emojis
 */
export type ReactionEmoji =
	| "👍"
	| "👎"
	| "❤️"
	| "🎉"
	| "😂"
	| "😮"
	| "😢"
	| "🤔"
	| "👏"
	| "🙌";
