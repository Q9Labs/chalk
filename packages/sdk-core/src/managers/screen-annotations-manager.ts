/**
 * Screen annotations manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { AnnotationAccessMode, ScreenAnnotationAccessChange, ScreenAnnotationCursor, ScreenAnnotationItem, ScreenAnnotationSession, ScreenAnnotationSnapshot, ScreenAnnotationTool, ScreenAnnotationUpdate } from "../types/entities/annotations.ts";
import { TypedEventEmitter } from "../utils/typed-emitter";
import { wideEvents } from "../wide-events/index.ts";

export interface ScreenAnnotationsState {
  shareSessionId: string | null;
  sharerParticipantId: string | null;
  accessMode: AnnotationAccessMode;
  items: readonly ScreenAnnotationItem[];
  cursors: readonly ScreenAnnotationCursor[];
  lastSeq: number;
  isOpen: boolean;
  isSessionActive: boolean;
  canDraw: boolean;
}

export interface ScreenAnnotationsManagerEvents {
  update: ScreenAnnotationUpdate;
  snapshot: ScreenAnnotationSnapshot;
  cursor: ScreenAnnotationCursor;
  "session:started": ScreenAnnotationSession;
  "session:ended": { shareSessionId: string; endedAt: Date };
  "access:changed": ScreenAnnotationAccessChange;
  error: ChalkError;
}

const DEFAULT_ACCESS_MODE: AnnotationAccessMode = "all";

export class ScreenAnnotationsManager extends StateContainer<ScreenAnnotationsState> {
  private readonly events = new TypedEventEmitter<ScreenAnnotationsManagerEvents>();
  private room: ConferenceSession | null = null;
  private roomUnsubscribers: Array<() => void> = [];
  private cursors = new Map<string, ScreenAnnotationCursor>();

  constructor() {
    super({
      shareSessionId: null,
      sharerParticipantId: null,
      accessMode: DEFAULT_ACCESS_MODE,
      items: [],
      cursors: [],
      lastSeq: 0,
      isOpen: false,
      isSessionActive: false,
      canDraw: false,
    });
  }

  on<K extends keyof ScreenAnnotationsManagerEvents>(event: K, handler: (data: ScreenAnnotationsManagerEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  attachRoom(room: ConferenceSession): void {
    this.teardownRoomListeners();
    this.room = room;
    this.setupRoomListeners();
    this.syncDerivedState();
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

  private emitTelemetry(eventType: string, data: Record<string, unknown> = {}): void {
    if (!wideEvents.isEnabled) {
      return;
    }

    const state = this.getState();
    const ctx = wideEvents.start(eventType);
    ctx.merge({
      shareSessionId: state.shareSessionId,
      sharerParticipantId: state.sharerParticipantId,
      accessMode: state.accessMode,
      isSessionActive: state.isSessionActive,
      isOpen: state.isOpen,
      canDraw: state.canDraw,
      itemCount: state.items.length,
      cursorCount: this.cursors.size,
      ...data,
    });
    ctx.complete("success");
  }

  private syncDerivedState(): void {
    const state = this.getState();
    this.setState({
      canDraw: Boolean(this.room) && state.isSessionActive && this.room!.canDrawAnnotations(),
    });
  }

  private resetSession(keepOpen = false): void {
    this.cursors.clear();
    this.setState({
      shareSessionId: null,
      sharerParticipantId: null,
      accessMode: DEFAULT_ACCESS_MODE,
      items: [],
      cursors: [],
      lastSeq: 0,
      isSessionActive: false,
      canDraw: false,
      isOpen: keepOpen ? this.getState().isOpen : false,
    });
  }

  private setupRoomListeners(): void {
    if (!this.room) {
      return;
    }

    const room = this.room;

    this.roomUnsubscribers.push(
      room.on("annotation.session.started", (session) => {
        this.cursors.clear();
        this.setState({
          shareSessionId: session.shareSessionId,
          sharerParticipantId: session.sharerParticipantId,
          accessMode: session.accessMode,
          items: [],
          cursors: [],
          lastSeq: 0,
          isSessionActive: true,
        });
        this.syncDerivedState();
        this.emitTelemetry("annotations.session.started", {
          shareSessionId: session.shareSessionId,
          sharerParticipantId: session.sharerParticipantId,
          accessMode: session.accessMode,
          transport: "ws",
        });
        this.events.emit("session:started", session);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("annotation.session.ended", (session) => {
        this.resetSession(this.getState().isOpen);
        this.emitTelemetry("annotations.session.ended", {
          shareSessionId: session.shareSessionId,
          endedAt: session.endedAt.toISOString(),
          transport: "ws",
        });
        this.events.emit("session:ended", session);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("annotation.snapshot", (snapshot) => {
        this.cursors.clear();
        this.setState({
          shareSessionId: snapshot.shareSessionId,
          sharerParticipantId: snapshot.sharerParticipantId,
          accessMode: snapshot.accessMode,
          items: snapshot.items as ScreenAnnotationItem[],
          cursors: [],
          lastSeq: snapshot.lastSeq,
          isSessionActive: true,
        });
        this.syncDerivedState();
        this.emitTelemetry("annotations.snapshot", {
          shareSessionId: snapshot.shareSessionId,
          sharerParticipantId: snapshot.sharerParticipantId,
          accessMode: snapshot.accessMode,
          lastSeq: snapshot.lastSeq,
          itemCount: snapshot.items.length,
          transport: "ws",
        });
        this.events.emit("snapshot", {
          ...snapshot,
          items: snapshot.items as ScreenAnnotationItem[],
        });
      }),
    );

    this.roomUnsubscribers.push(
      room.on("annotation.update", (update) => {
        this.setState({
          shareSessionId: update.shareSessionId,
          sharerParticipantId: update.sharerParticipantId,
          items: update.items as ScreenAnnotationItem[],
          lastSeq: update.seq,
          isSessionActive: true,
        });
        this.syncDerivedState();
        this.emitTelemetry("annotations.update.remote", {
          shareSessionId: update.shareSessionId,
          sharerParticipantId: update.sharerParticipantId,
          participantId: update.participantId,
          seq: update.seq,
          syncAll: update.syncAll,
          itemCount: update.items.length,
          transport: "ws",
        });
        this.events.emit("update", {
          ...update,
          items: update.items as ScreenAnnotationItem[],
        });
      }),
    );

    this.roomUnsubscribers.push(
      room.on("annotation.cursor", (cursor) => {
        this.cursors.set(cursor.participantId, cursor);
        this.setState({ cursors: Array.from(this.cursors.values()) });
        this.events.emit("cursor", cursor);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("annotation.access.changed", (change) => {
        this.setState({ accessMode: change.accessMode });
        this.syncDerivedState();
        this.emitTelemetry("annotations.access.changed", {
          shareSessionId: change.shareSessionId,
          accessMode: change.accessMode,
          changedBy: change.changedBy,
          transport: "ws",
        });
        this.events.emit("access:changed", change);
      }),
    );

    this.roomUnsubscribers.push(
      room.on("participant.left", (participantId) => {
        this.cursors.delete(participantId);
        this.setState({ cursors: Array.from(this.cursors.values()) });
      }),
    );
  }

  open(): void {
    this.setState({ isOpen: true });
    this.emitTelemetry("annotations.open", {
      trigger: "manager",
    });
  }

  close(): void {
    this.setState({ isOpen: false });
    this.emitTelemetry("annotations.close", {
      trigger: "manager",
    });
  }

  toggle(): void {
    this.setState({ isOpen: !this.getState().isOpen });
  }

  startSession(shareSessionId: string, sharerParticipantId: string, accessMode: AnnotationAccessMode = DEFAULT_ACCESS_MODE): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    if (this.room.localParticipant?.id !== sharerParticipantId) {
      this.emitTelemetry("annotations.session.start", {
        requestedShareSessionId: shareSessionId,
        requestedSharerParticipantId: sharerParticipantId,
        requestedAccessMode: accessMode,
        result: "ignored_non_local_sharer",
      });
      return;
    }

    this.cursors.clear();
    this.room._setAnnotationSession(shareSessionId, sharerParticipantId);
    this.room._setAnnotationAccessMode(accessMode);
    this.setState({
      shareSessionId,
      sharerParticipantId,
      accessMode,
      items: [],
      cursors: [],
      lastSeq: 0,
      isSessionActive: true,
    });
    this.syncDerivedState();
    this.emitTelemetry("annotations.session.start", {
      requestedShareSessionId: shareSessionId,
      requestedSharerParticipantId: sharerParticipantId,
      requestedAccessMode: accessMode,
      trigger: "local",
      transport: "manager",
      result: "sent",
    });
    this.room.startAnnotationSession(shareSessionId, accessMode);
  }

  endSession(shareSessionId?: string): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const resolvedShareSessionId = shareSessionId ?? this.getState().shareSessionId ?? undefined;
    this.emitTelemetry("annotations.session.end", {
      requestedShareSessionId: resolvedShareSessionId ?? null,
      transport: "manager",
    });
    this.room.endAnnotationSession(resolvedShareSessionId);
  }

  requestSync(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    this.emitTelemetry("annotations.sync.request", {
      requestedShareSessionId: this.getState().shareSessionId,
      transport: "manager",
    });
    this.room.requestAnnotationSync();
  }

  replaceItems(items: ScreenAnnotationItem[]): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const state = this.getState();
    if (!state.shareSessionId || !state.sharerParticipantId || !state.isSessionActive || !state.canDraw) {
      return;
    }

    const seq = Date.now();
    this.setState({ items, lastSeq: seq });
    this.emitTelemetry("annotations.update.local", {
      shareSessionId: state.shareSessionId,
      sharerParticipantId: state.sharerParticipantId,
      seq,
      syncAll: true,
      itemCount: items.length,
      transport: "manager",
    });
    this.room.sendAnnotationUpdate({
      shareSessionId: state.shareSessionId,
      sharerParticipantId: state.sharerParticipantId,
      syncAll: true,
      items,
      seq,
    });
  }

  clear(): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const shareSessionId = this.getState().shareSessionId;
    if (!shareSessionId) {
      return;
    }

    this.setState({ items: [], lastSeq: Date.now() });
    this.emitTelemetry("annotations.clear", {
      shareSessionId,
      transport: "manager",
    });
    this.room.clearAnnotations(shareSessionId);
  }

  sendCursor(x: number, y: number, tool: ScreenAnnotationTool): void {
    if (!this.room) {
      return;
    }

    const shareSessionId = this.getState().shareSessionId;
    if (!shareSessionId) {
      return;
    }

    this.room.sendAnnotationCursor({
      shareSessionId,
      x,
      y,
      tool,
    });
  }

  setAccessMode(accessMode: AnnotationAccessMode): void {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const shareSessionId = this.getState().shareSessionId;
    if (!shareSessionId) {
      return;
    }

    this.emitTelemetry("annotations.access.set", {
      shareSessionId,
      nextAccessMode: accessMode,
      transport: "manager",
    });
    this.room.setAnnotationAccessMode(accessMode, shareSessionId);
  }

  dispose(): void {
    this.teardownRoomListeners();
    this.room = null;
    this.cursors.clear();
    this.events.removeAllListeners();
  }
}
