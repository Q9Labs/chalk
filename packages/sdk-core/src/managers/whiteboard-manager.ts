/**
 * Whiteboard manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { WhiteboardCursor, WhiteboardPermission, WhiteboardSnapshot, WhiteboardUpdate } from "../types/entities/whiteboard";
import { TypedEventEmitter } from "../utils/typed-emitter";
import { reduceLocalWhiteboardUpdate, reduceRemoteWhiteboardUpdate, reduceWhiteboardClear, reduceWhiteboardClosed, reduceWhiteboardCursorState, reduceWhiteboardOpened, reduceWhiteboardParticipantLeft, reduceWhiteboardPermissionSync, reduceWhiteboardSnapshot } from "./whiteboard/whiteboard-reducer";
import { WhiteboardDebouncedScheduler } from "./whiteboard/whiteboard-scheduler";

/** Whiteboard manager state */
export interface WhiteboardState {
  /** Current whiteboard scene epoch */
  readonly sceneId?: string;
  /** Whether whiteboard is open */
  readonly isOpen: boolean;
  /** Whether local user can draw */
  readonly canDraw: boolean;
  /** Current elements on the whiteboard */
  readonly elements: readonly unknown[];
  /** Current files (images, etc.) */
  readonly files: Readonly<Record<string, unknown>>;
  /** Other participants' cursors */
  readonly cursors: readonly WhiteboardCursor[];
  /** Last sequence number */
  readonly lastSeq: number;
  /** Participant IDs who have whiteboard open */
  readonly openParticipants: readonly string[];
}

/** Whiteboard manager events */
export interface WhiteboardManagerEvents {
  /** Whiteboard update received */
  update: WhiteboardUpdate;
  /** Snapshot received */
  snapshot: WhiteboardSnapshot;
  /** Cursor update received */
  cursor: WhiteboardCursor;
  /** Permission changed */
  "permission:changed": WhiteboardPermission;
  /** Whiteboard opened by participant */
  opened: { participantId: string; displayName: string };
  /** Whiteboard closed by participant */
  closed: { participantId: string };
  /** Error occurred */
  error: ChalkError;
}

const CURSOR_DEBOUNCE_MS = 50;
const UPDATE_DEBOUNCE_MS = 100;

/**
 * Manages whiteboard collaboration via WebSocket
 *
 * Whiteboard is ephemeral - content is cleared when the meeting truly ends.
 */
export class WhiteboardManager extends StateContainer<WhiteboardState> {
  private readonly events = new TypedEventEmitter<WhiteboardManagerEvents>();
  private readonly updateScheduler = new WhiteboardDebouncedScheduler(UPDATE_DEBOUNCE_MS);
  private readonly cursorScheduler = new WhiteboardDebouncedScheduler(CURSOR_DEBOUNCE_MS);
  private room: ConferenceSession | null = null;
  private roomUnsubscribers: Array<() => void> = [];
  private cursors = new Map<string, WhiteboardCursor>();
  private pendingElements: unknown[] | null = null;
  private pendingFiles: Record<string, unknown> | null = null;
  private lastSeqByParticipant = new Map<string, number>();
  private openParticipants = new Set<string>();

  constructor(_debug = false) {
    super({
      sceneId: undefined,
      isOpen: false,
      canDraw: true, // Default to true, will be updated from API
      elements: [],
      files: {},
      cursors: [],
      lastSeq: 0,
      openParticipants: [],
    });
  }

  /** Subscribe to whiteboard events */
  on<K extends keyof WhiteboardManagerEvents>(event: K, handler: (data: WhiteboardManagerEvents[K]) => void): () => void {
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

    // Check local participant's permission
    const canDraw = this.room.canDrawWhiteboard();
    this.setState(reduceWhiteboardPermissionSync(canDraw));
  }

  private setupRoomListeners(): void {
    if (!this.room) return;
    const room = this.room;
    this.roomUnsubscribers.push(
      room.on("whiteboard.update", (data) => {
        const update: WhiteboardUpdate = {
          schemaVersion: data.schemaVersion,
          sceneId: data.sceneId,
          syncAll: data.syncAll,
          participantId: data.participantId,
          displayName: data.displayName,
          elements: data.elements,
          files: data.files,
          seq: data.seq,
          timestamp: new Date(),
        };

        const lastSeq = this.lastSeqByParticipant.get(data.participantId) ?? 0;
        if (data.seq > lastSeq) {
          const currentState = this.getState();
          this.lastSeqByParticipant.set(data.participantId, data.seq);
          this.setState(
            reduceRemoteWhiteboardUpdate({
              state: currentState,
              sceneId: data.sceneId,
              syncAll: data.syncAll,
              elements: data.elements,
              files: data.files,
              seq: data.seq,
            }),
          );
        }

        this.events.emit("update", update);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("whiteboard.snapshot", (data) => {
        const snapshot: WhiteboardSnapshot = {
          schemaVersion: data.schemaVersion,
          roomId: data.roomId,
          sceneId: data.sceneId,
          elements: data.elements,
          files: data.files,
          appState: data.appState,
          updatedAtMs: data.updatedAtMs,
          lastSeq: data.lastSeq,
        };

        this.lastSeqByParticipant.clear();
        this.setState(
          reduceWhiteboardSnapshot({
            sceneId: data.sceneId,
            elements: data.elements,
            files: data.files,
            lastSeq: data.lastSeq,
          }),
        );
        this.events.emit("snapshot", snapshot);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("whiteboard.cursor", (data) => {
        const cursor: WhiteboardCursor = {
          participantId: data.participantId,
          displayName: data.displayName,
          x: data.x,
          y: data.y,
          timestamp: new Date(),
        };

        this.cursors.set(data.participantId, cursor);
        this.setState(reduceWhiteboardCursorState(this.cursors));
        this.events.emit("cursor", cursor);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("whiteboard.permission.changed", (data) => {
        // Update local permission if it's for us
        const localId = this.room?.localParticipant?.id;
        if (data.participantId === localId) {
          this.setState(reduceWhiteboardPermissionSync(data.canDraw));
        }

        const permission: WhiteboardPermission = {
          participantId: data.participantId,
          feature: "whiteboard",
          canDraw: data.canDraw,
          grantedBy: "", // Not provided by room event
          timestamp: new Date(),
        };

        this.events.emit("permission:changed", permission);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("whiteboard.opened", (data) => {
        this.openParticipants.add(data.participantId);
        this.setState(reduceWhiteboardOpened(this.openParticipants));
        this.events.emit("opened", {
          participantId: data.participantId,
          displayName: data.displayName,
        });
      }),
    );

    this.roomUnsubscribers.push(
      room.on("whiteboard.closed", (data) => {
        this.openParticipants.delete(data.participantId);
        this.cursors.delete(data.participantId);
        this.setState(
          reduceWhiteboardClosed({
            openParticipants: this.openParticipants,
            cursors: this.cursors,
          }),
        );
        this.events.emit("closed", { participantId: data.participantId });
      }),
    );

    this.roomUnsubscribers.push(
      room.on("participant.left", (participantId) => {
        this.openParticipants.delete(participantId);
        this.cursors.delete(participantId);
        this.setState(
          reduceWhiteboardParticipantLeft({
            openParticipants: this.openParticipants,
            cursors: this.cursors,
          }),
        );
      }),
    );
  }

  /** Open whiteboard locally and notify others */
  open(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.openWhiteboard();
    this.setState({ isOpen: true });

    // Request current state
    this.room.requestWhiteboardSync();
  }

  /** Close whiteboard locally and notify others */
  close(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.closeWhiteboard();
    this.setState({ isOpen: false });
  }

  /** Toggle whiteboard open/closed */
  toggle(): void {
    if (this.getState().isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Request full sync from other participants */
  requestSync(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.requestWhiteboardSync();
  }

  /**
   * Send whiteboard update (debounced 100-200ms)
   * @param elements - Excalidraw elements array
   * @param files - Optional files map
   */
  sendUpdate(elements: unknown[], files?: Record<string, unknown>, seqOverride?: number): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    if (!this.getState().canDraw) {
      return; // Silently ignore if no permission
    }

    // Store pending data
    this.pendingElements = elements;
    this.pendingFiles = files ?? null;

    this.updateScheduler.schedule(() => {
      if (!this.pendingElements || !this.room) {
        return;
      }

      const currentState = this.getState();
      if (!currentState.sceneId) {
        this.room.requestWhiteboardSync();
        return;
      }

      const seq = typeof seqOverride === "number" ? seqOverride : Date.now();
      this.room.sendWhiteboardUpdateV2({
        sceneId: currentState.sceneId,
        syncAll: false,
        elements: this.pendingElements,
        seq,
      });

      this.setState(
        reduceLocalWhiteboardUpdate({
          state: currentState,
          elements: this.pendingElements,
          files: this.pendingFiles,
          seq,
        }),
      );
      this.pendingElements = null;
      this.pendingFiles = null;
    });
  }

  /**
   * Send cursor position (debounced)
   */
  sendCursor(x: number, y: number): void {
    if (!this.room) return;

    this.cursorScheduler.schedule(() => {
      this.room?.sendWhiteboardCursor(x, y);
    });
  }

  /** Clear the whiteboard (host only) */
  clear(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.clearWhiteboard();
    this.lastSeqByParticipant.clear();
    this.setState(reduceWhiteboardClear());
  }

  /** Grant drawing permission to a participant (host only) */
  grantPermission(participantId: string): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.grantWhiteboardPermission(participantId);
  }

  /** Revoke drawing permission from a participant (host only) */
  revokePermission(participantId: string): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.room.revokeWhiteboardPermission(participantId);
  }

  /** Cleanup resources */
  dispose(): void {
    this.teardownRoomListeners();
    this.room = null;
    this.updateScheduler.cancel();
    this.cursorScheduler.cancel();
    this.lastSeqByParticipant.clear();
    this.cursors.clear();
    this.openParticipants.clear();
    this.events.removeAllListeners();
  }
}
