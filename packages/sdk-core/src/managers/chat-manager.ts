/**
 * Chat manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { ChatMessage, ReactionEmoji } from "../types";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Chat manager state */
export interface ChatState {
	/** All messages in chronological order */
	readonly messages: readonly ChatMessage[];
	/** Whether chat is enabled */
	readonly isEnabled: boolean;
	/** Message count */
	readonly count: number;
	/** Unread message count */
	readonly unreadCount: number;
}

/** Chat manager events */
export interface ChatManagerEvents {
	/** New message received */
	message: { message: ChatMessage };
	/** Message reaction added */
	reaction: { messageId: string; emoji: string; participantId: string };
	/** Error occurred */
	error: ChalkError;
}

/**
 * Manages chat messages and reactions
 *
 * Chat is ephemeral - messages are cleared when the meeting ends.
 */
export class ChatManager extends StateContainer<ChatState> {
	private readonly events = new TypedEventEmitter<ChatManagerEvents>();
	private room: ConferenceSession | null = null;
	private messages: ChatMessage[] = [];
	private unreadCount = 0;
	private isChatVisible = false;

	constructor(_debug = false) {
		super({
			messages: [],
			isEnabled: true,
			count: 0,
			unreadCount: 0,
		});
	}

	/** Subscribe to chat events */
	on<K extends keyof ChatManagerEvents>(
		event: K,
		handler: (data: ChatManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach ConferenceSession instance */
	attachRoom(room: ConferenceSession): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncFromRoom();
	}

	private syncFromRoom(): void {
		if (!this.room) return;

		this.messages = this.room.messages.map((m) => this.normalizeMessage(m));
		this.updateState();
	}

	private normalizeMessage(m: ChatMessage): ChatMessage {
		return {
			id: m.id,
			content: m.content,
			senderId: m.senderId,
			senderName: m.senderName,
			timestamp:
				m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
		};
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("chat.message", (message) => {
			const normalized = this.normalizeMessage(message);
			this.messages.push(normalized);

			// Increment unread if chat is not visible
			if (!this.isChatVisible) {
				this.unreadCount++;
			}

			this.updateState();
			this.events.emit("message", { message: normalized });
		});
	}

	private updateState(): void {
		this.setState({
			messages: [...this.messages],
			count: this.messages.length,
			unreadCount: this.unreadCount,
		});
	}

	/** Send a chat message */
	sendMessage(content: string): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (!content.trim()) {
			return;
		}

		this.room.sendMessage(content);
	}

	/** React to a message with an emoji */
	reactToMessage(messageId: string, emoji: ReactionEmoji): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		// Find the message
		const message = this.messages.find((m) => m.id === messageId);
		if (!message) return;

		const localId = this.room.localParticipant?.id;
		if (!localId) return;

		// TODO: Send reaction to server when API supports it
		// For now, just emit the event locally
		this.updateState();
		this.events.emit("reaction", { messageId, emoji, participantId: localId });
	}

	/** Mark chat as visible (resets unread count) */
	markAsRead(): void {
		this.isChatVisible = true;
		this.unreadCount = 0;
		this.updateState();
	}

	/** Mark chat as hidden (starts counting unread) */
	markAsHidden(): void {
		this.isChatVisible = false;
	}

	/** Clear all messages (used when meeting ends) */
	clear(): void {
		this.messages = [];
		this.unreadCount = 0;
		this.updateState();
	}

	/** Get message by ID */
	getMessage(id: string): ChatMessage | undefined {
		return this.messages.find((m) => m.id === id);
	}

	/** Cleanup resources */
	dispose(): void {
		this.clear();
		this.events.removeAllListeners();
	}
}
