/**
 * Chat manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { ChatAttachment, ChatMessage, ReactionEmoji } from "../types";
import { TypedEventEmitter } from "../utils/typed-emitter";

interface ChatAttachmentUploadSpec {
  attachmentId: string;
  uploadUrl: string;
  expiresAtMs: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachment["kind"];
}

interface ChatTransport {
  presignUpload: (files: Array<{ fileName: string; mimeType: string; sizeBytes: number }>) => Promise<ChatAttachmentUploadSpec[]>;
  uploadAttachment: (attachmentId: string, file: File) => Promise<void>;
  presignDownload: (attachmentId: string) => Promise<string>;
}

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
 */
export class ChatManager extends StateContainer<ChatState> {
  private readonly events = new TypedEventEmitter<ChatManagerEvents>();
  private room: ConferenceSession | null = null;
  private roomUnsubscribers: Array<() => void> = [];
  private messages: ChatMessage[] = [];
  private unreadCount = 0;
  private isChatVisible = false;
  private transport: ChatTransport | null = null;

  constructor(_debug = false) {
    super({
      messages: [],
      isEnabled: true,
      count: 0,
      unreadCount: 0,
    });
  }

  configureTransport(transport: ChatTransport): void {
    this.transport = transport;
  }

  /** Subscribe to chat events */
  on<K extends keyof ChatManagerEvents>(event: K, handler: (data: ChatManagerEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  /** Attach ConferenceSession instance */
  attachRoom(room: ConferenceSession): void {
    this.teardownRoomListeners();
    this.room = room;
    this.setupRoomListeners();
    this.syncFromRoom();
  }

  private teardownRoomListeners(): void {
    for (const unsubscribe of this.roomUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best effort cleanup
      }
    }
    this.roomUnsubscribers = [];
  }

  private syncFromRoom(): void {
    if (!this.room) return;

    this.messages = this.room.messages.map((message) => this.normalizeMessage(message));
    this.updateState();
  }

  private normalizeMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      attachments: (message.attachments ?? []).map((attachment) => ({
        ...attachment,
      })),
      readBy: (message.readBy ?? []).map((receipt) => ({
        ...receipt,
        readAt: receipt.readAt instanceof Date ? receipt.readAt : new Date(receipt.readAt),
      })),
    };
  }

  private setupRoomListeners(): void {
    if (!this.room) return;

    this.roomUnsubscribers.push(
      this.room.on("chat.message", (message) => {
        const normalized = this.normalizeMessage(message);
        this.messages.push(normalized);

        if (!this.isChatVisible) {
          this.unreadCount++;
        } else if (this.room && normalized.senderId !== this.room.localParticipant?.id) {
          this.room.markChatRead(normalized.id);
        }

        this.updateState();
        this.events.emit("message", { message: normalized });
      }),
    );

    this.roomUnsubscribers.push(
      this.room.on("chat.read", () => {
        this.syncFromRoom();
      }),
    );
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
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    if (!content.trim()) {
      return;
    }

    this.room.sendMessage(content);
  }

  async sendMessageWithAttachments(content: string, files: File[]): Promise<void> {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }
    if (!this.transport) {
      throw new ChalkError(ChalkErrorCode.INVALID_REQUEST, "Chat attachment transport unavailable");
    }
    if (files.length === 0) {
      this.sendMessage(content);
      return;
    }

    const uploadSpecs = await this.transport.presignUpload(
      files.map((file) => ({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      })),
    );

    for (let index = 0; index < uploadSpecs.length; index++) {
      const spec = uploadSpecs[index];
      if (!spec) continue;

      const file = files[index];
      if (!file) continue;

      await this.transport.uploadAttachment(spec.attachmentId, file);
    }

    this.room.sendMessage(
      content,
      uploadSpecs.map((spec) => spec.attachmentId),
    );
  }

  async getAttachmentDownloadUrl(attachmentId: string): Promise<string> {
    if (!this.transport) {
      throw new ChalkError(ChalkErrorCode.INVALID_REQUEST, "Chat attachment transport unavailable");
    }
    return this.transport.presignDownload(attachmentId);
  }

  /** React to a message with an emoji */
  reactToMessage(messageId: string, emoji: ReactionEmoji): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return;

    const localId = this.room.localParticipant?.id;
    if (!localId) return;

    this.updateState();
    this.events.emit("reaction", { messageId, emoji, participantId: localId });
  }

  /** Mark chat as visible (resets unread count and syncs read-through) */
  markAsRead(): void {
    this.isChatVisible = true;
    this.unreadCount = 0;
    this.updateState();

    const readThroughMessageId = this.latestRemoteMessageId();
    if (readThroughMessageId && this.room) {
      this.room.markChatRead(readThroughMessageId);
    }
  }

  /** Mark chat as hidden (starts counting unread) */
  markAsHidden(): void {
    this.isChatVisible = false;
  }

  private latestRemoteMessageId(): string | null {
    const localParticipantId = this.room?.localParticipant?.id;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message && message.senderId !== localParticipantId) {
        return message.id;
      }
    }
    return null;
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
    this.teardownRoomListeners();
    this.room = null;
    this.clear();
    this.events.removeAllListeners();
  }
}
