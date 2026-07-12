import { ChalkErrorClass, type ChalkError, type ChalkSession, type ChalkSessionDiagnosticsSnapshot, type RoomState } from "../internal/core";
import type { NativeVideoConferenceCallKitOptions } from "../callkit/resolve-native-video-conference-callkit-options";
import type { NativeTelemetry } from "../telemetry";
import { canExecuteNativeJoin, canStartNativeJoin, shouldFailNativeJoinAfterDisconnect, shouldPromoteAfterJoinError } from "../utils/native-join-guard";
import { resolveNativeJoinDefaults } from "./native-join-defaults";
import type { NativeMeetingEndData } from "./NativeEndScreen";
import type { NativeJoinSettings } from "./NativePreJoinLobby";
import type { NativeMeetingRoomDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";
import type { NativeMeetingJoinedData, NativeVideoConferencePhase } from "./NativeVideoConference";
import { NativeVideoConferenceCallKitController } from "./native-video-conference-callkit-controller";
import { resolveInitialNativeVideoConferencePhase, shouldResumeNativeMeetingPhase } from "./native-video-conference-phase";

export interface NativeVideoConferenceDiagnosticsSnapshot {
  phase: NativeVideoConferencePhase;
  roomId: string;
  roomName: string;
  joinNonce: number;
  pendingJoinRequest: boolean;
  activeJoinNonce: number | null;
  lastJoinError: string | null;
  connectionStatus: string;
  isConnected: boolean;
  isJoining: boolean;
  session: ChalkSessionDiagnosticsSnapshot;
  meetingRoom: NativeMeetingRoomDiagnosticsSnapshot | null;
}

export interface NativeVideoConferenceControllerSnapshot {
  readonly phase: NativeVideoConferencePhase;
  readonly joinSettings: NativeJoinSettings;
  readonly joinError: string | null;
  readonly joinNonce: number;
  readonly pendingJoinRequest: boolean;
  readonly endData: NativeMeetingEndData | null;
  readonly meetingRoomDiagnostics: NativeMeetingRoomDiagnosticsSnapshot | null;
}

export interface NativeVideoConferenceControllerOptions {
  readonly roomId: string;
  readonly roomName?: string;
  readonly userName?: string;
  readonly role: "host" | "participant";
  readonly autoJoin: boolean;
  readonly initialPhase?: NativeVideoConferencePhase;
  readonly initialJoinSettings?: Partial<NativeJoinSettings>;
  readonly simulatorMediaDisabled: boolean;
  readonly callKit?: NativeVideoConferenceCallKitOptions | boolean;
  readonly session: ChalkSession;
  readonly telemetry: NativeTelemetry | undefined;
  readonly participantCount: number;
  readonly chatCount: number;
  readonly transcriptCount: number;
  readonly onJoin?: (data: NativeMeetingJoinedData) => void;
  readonly onLeave?: () => void;
  readonly onEnd?: (data: NativeMeetingEndData) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: ChalkError) => void;
  readonly onDiagnosticsChange?: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
}

type Listener = () => void;
type Cleanup = () => void;
type DisconnectOptions = { closeAfterLeave?: boolean };

export class NativeVideoConferenceController {
  readonly #session: ChalkSession;
  #options: NativeVideoConferenceControllerOptions;
  #snapshot: NativeVideoConferenceControllerSnapshot;
  #listeners = new Set<Listener>();
  #externalCleanups: Cleanup[] = [];
  #joinGuardTimer: ReturnType<typeof setTimeout> | undefined;
  #joinedAt: Date | null = null;
  #activeJoinNonce: number | null = null;
  #activeJoinStartedAt: number | null;
  #didEmitJoin = false;
  #didEmitEnd = false;
  readonly #callKitController: NativeVideoConferenceCallKitController;
  #lastDiagnosticsSignature: string | null = null;
  #disposeGeneration = 0;

  constructor(options: NativeVideoConferenceControllerOptions) {
    this.#session = options.session;
    this.#options = options;
    this.#callKitController = new NativeVideoConferenceCallKitController();

    const room = this.#roomState();
    const initialJoin = options.initialPhase === "joining" || options.autoJoin;
    const joinSettings = resolveNativeJoinDefaults({
      initialJoinSettings: options.initialJoinSettings,
      simulatorMediaDisabled: options.simulatorMediaDisabled,
      userName: options.userName,
    });
    this.#activeJoinStartedAt = initialJoin ? Date.now() : null;
    this.#snapshot = {
      phase: resolveInitialNativeVideoConferencePhase({
        initialPhase: options.initialPhase,
        autoJoin: options.autoJoin,
        isConnected: room.status === "connected",
        activeRoomId: room.roomId,
        roomId: options.roomId,
      }),
      joinSettings,
      joinError: null,
      joinNonce: initialJoin ? 1 : 0,
      pendingJoinRequest: initialJoin,
      endData: null,
      meetingRoomDiagnostics: null,
    };
  }

  readonly getSnapshot = (): NativeVideoConferenceControllerSnapshot => this.#snapshot;

  readonly updateOptions = (options: NativeVideoConferenceControllerOptions): void => {
    if (options.onDiagnosticsChange !== this.#options.onDiagnosticsChange) {
      this.#lastDiagnosticsSignature = null;
    }
    this.#options = options;
  };

  readonly subscribe = (listener: Listener): Cleanup => {
    this.#listeners.add(listener);
    const generation = ++this.#disposeGeneration;
    if (this.#listeners.size === 1) {
      if (this.#externalCleanups.length === 0) {
        this.#start();
      } else {
        this.#reconcile();
      }
    }

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        queueMicrotask(() => {
          if (generation !== this.#disposeGeneration || this.#listeners.size > 0) return;
          this.#disposeGeneration += 1;
          this.#stop();
        });
      }
    };
  };

  readonly startJoin = (settings: NativeJoinSettings): void => {
    const room = this.#roomState();
    if (!canStartNativeJoin(this.#snapshot.phase, room.isJoining, room.status === "connected", this.#snapshot.pendingJoinRequest)) return;

    this.#activeJoinStartedAt = Date.now();
    this.#didEmitEnd = false;
    this.#replaceSnapshot({
      endData: null,
      joinError: null,
      joinNonce: this.#snapshot.joinNonce + 1,
      joinSettings: {
        displayName: settings.displayName.trim() || this.#defaultSettings().displayName,
        audioEnabled: this.#options.simulatorMediaDisabled ? false : settings.audioEnabled,
        videoEnabled: this.#options.simulatorMediaDisabled ? false : settings.videoEnabled,
      },
      pendingJoinRequest: true,
      phase: "joining",
    });
    this.#reconcile();
  };

  readonly retryJoin = (): void => {
    const room = this.#roomState();
    if (room.isJoining || room.status === "connected" || this.#snapshot.pendingJoinRequest) return;

    this.#activeJoinStartedAt = Date.now();
    this.#replaceSnapshot({
      joinError: null,
      joinNonce: this.#snapshot.joinNonce + 1,
      pendingJoinRequest: true,
      phase: "joining",
    });
    this.#reconcile();
  };

  readonly handleRejoin = (): void => {
    this.#activeJoinNonce = null;
    this.#activeJoinStartedAt = Date.now();
    this.#didEmitJoin = false;
    this.#didEmitEnd = false;
    this.#joinedAt = null;
    this.#replaceSnapshot({
      endData: null,
      joinError: null,
      joinNonce: this.#snapshot.joinNonce + 1,
      pendingJoinRequest: true,
      phase: "joining",
    });
    this.#reconcile();
  };

  readonly disconnect = async (options?: DisconnectOptions): Promise<void> => {
    this.#activeJoinNonce = null;
    this.#activeJoinStartedAt = null;
    this.#replaceSnapshot({ pendingJoinRequest: false });
    await this.#callKitController.endCall();

    if (this.#snapshot.phase === "meeting") {
      this.#finalizeMeeting();
    } else {
      this.#replaceSnapshot({ joinError: null, phase: "lobby" });
    }

    this.#options.telemetry?.recordSyncFrame({ direction: "client_to_server", frameType: "room.leave" });
    await this.#session.leave();

    if (options?.closeAfterLeave) this.#options.onClose?.();
  };

  readonly handleEndForAll = async (): Promise<void> => {
    this.#activeJoinStartedAt = null;
    this.#replaceSnapshot({ pendingJoinRequest: false });
    await this.#callKitController.endCall();
    this.#finalizeMeeting();
    await this.#session.leave({ endForAll: true });
  };

  readonly setMeetingRoomDiagnostics = (meetingRoomDiagnostics: NativeMeetingRoomDiagnosticsSnapshot): void => {
    this.#replaceSnapshot({ meetingRoomDiagnostics });
    this.#notifyDiagnostics();
  };

  #start(): void {
    this.#callKitController.start();
    this.#externalCleanups = [
      this.#session.room.subscribe(this.#reconcile),
      this.#session.media.subscribe(this.#reconcile),
      this.#session.participants.subscribe(this.#reconcile),
      this.#session.chat.subscribe(this.#reconcile),
      this.#session.on("error", (error: ChalkError) => this.#options.onError?.(error)),
    ];

    this.#reconcile();
  }

  #stop(): void {
    this.#clearJoinGuardTimer();
    for (const cleanup of this.#externalCleanups) cleanup();
    this.#externalCleanups = [];
    this.#lastDiagnosticsSignature = null;
    this.#callKitController.stop();
  }

  #reconcile = (): void => {
    const room = this.#roomState();
    const isConnected = room.status === "connected";

    if (this.#snapshot.phase === "joining" && isConnected) {
      this.#promoteToMeeting();
    }

    if (this.#snapshot.phase === "lobby" && shouldResumeNativeMeetingPhase({ isConnected, activeRoomId: room.roomId, roomId: this.#options.roomId })) {
      this.#promoteToMeeting();
    }

    if (this.#snapshot.phase === "meeting" && (room.status === "disconnected" || room.status === "failed")) {
      this.#finalizeMeeting();
    }

    if (this.#snapshot.phase === "joining") {
      this.#startJoinAttempt(room);
      this.#checkJoinGuard(room);
    } else {
      this.#clearJoinGuardTimer();
    }

    this.#callKitController.sync({
      callKit: this.#options.callKit,
      hasVideo: this.#snapshot.joinSettings.videoEnabled,
      isAudioEnabled: this.#session.media.getState().isAudioEnabled,
      joinNonce: this.#snapshot.joinNonce,
      onEndCall: (options) => void this.disconnect(options),
      onToggleAudio: () => this.#session.media.toggleAudio(),
      phase: this.#snapshot.phase,
      roomId: this.#options.roomId,
      roomName: this.#options.roomName,
    });
    this.#notifyDiagnostics();
  };

  #startJoinAttempt(room: RoomState): void {
    if (!canExecuteNativeJoin(this.#snapshot.phase, this.#snapshot.joinNonce, room.isJoining, room.status === "connected", this.#snapshot.pendingJoinRequest, this.#activeJoinNonce)) return;

    const joinNonce = this.#snapshot.joinNonce;
    this.#activeJoinNonce = joinNonce;
    this.#replaceSnapshot({ joinError: null });
    const settings = this.#snapshot.joinSettings;
    const joinOptions = {
      userName: settings.displayName,
      role: this.#options.role,
      audioEnabled: this.#options.simulatorMediaDisabled ? false : settings.audioEnabled,
      videoEnabled: this.#options.simulatorMediaDisabled ? false : settings.videoEnabled,
    };

    void this.#session.join(this.#options.roomId, joinOptions).catch((cause: unknown) => {
      if (this.#snapshot.phase !== "joining" || this.#activeJoinNonce !== joinNonce) return;

      const nextRoom = this.#roomState();
      const activeRoom = this.#session.room.getRoom();
      if (
        activeRoom ||
        shouldPromoteAfterJoinError({
          error: cause,
          expectedRoomId: this.#options.roomId,
          activeRoomId: nextRoom.id,
          roomStateRoomId: nextRoom.roomId,
          roomStatus: nextRoom.status,
        })
      ) {
        this.#promoteToMeeting();
        return;
      }

      this.#activeJoinNonce = null;
      this.#activeJoinStartedAt = null;
      this.#replaceSnapshot({
        joinError: ChalkErrorClass.wrap(cause).message,
        pendingJoinRequest: false,
        phase: "lobby",
      });
      void this.#callKitController.endCall();
      this.#reconcile();
    });
    this.#options.telemetry?.recordSyncFrame({ direction: "client_to_server", frameType: "room.join" });
  }

  #checkJoinGuard(room: RoomState): void {
    const startedAt = this.#activeJoinStartedAt;
    if (!this.#snapshot.pendingJoinRequest || this.#activeJoinNonce === null || startedAt === null) {
      this.#clearJoinGuardTimer();
      return;
    }

    const diagnostics = this.#session.getDiagnosticsSnapshot();
    const joinAttemptAgeMs = Date.now() - startedAt;
    const shouldFail = shouldFailNativeJoinAfterDisconnect({
      phase: this.#snapshot.phase,
      hasPendingJoinRequest: this.#snapshot.pendingJoinRequest,
      activeJoinNonce: this.#activeJoinNonce,
      isJoining: room.isJoining,
      isConnected: room.status === "connected",
      expectedRoomId: this.#options.roomId,
      activeRoomId: room.roomId,
      roomStatus: room.status,
      websocketConnectionState: diagnostics.websocketConnectionState,
      joinAttemptAgeMs,
    });

    if (shouldFail) {
      this.#activeJoinNonce = null;
      this.#activeJoinStartedAt = null;
      this.#replaceSnapshot({
        joinError: this.#resolveJoinDisconnectMessage(),
        pendingJoinRequest: false,
        phase: "lobby",
      });
      void this.#callKitController.endCall();
      this.#clearJoinGuardTimer();
      return;
    }

    const roomLooksStalled = room.roomId === this.#options.roomId && (room.status === "disconnected" || room.status === "failed") && !room.isJoining;
    if (!roomLooksStalled) {
      this.#clearJoinGuardTimer();
      return;
    }

    const nextCheckInMs = diagnostics.websocketConnectionState === "connecting" ? Math.max(0, 15_000 - joinAttemptAgeMs) : Math.max(0, 3_000 - joinAttemptAgeMs);
    if (nextCheckInMs <= 0) {
      this.#reconcile();
      return;
    }

    this.#clearJoinGuardTimer();
    this.#joinGuardTimer = setTimeout(
      () => {
        this.#joinGuardTimer = undefined;
        this.#reconcile();
      },
      Math.min(nextCheckInMs, 1_000),
    );
  }

  #promoteToMeeting(): void {
    const joinedAt = this.#joinedAt ?? new Date();
    this.#joinedAt = joinedAt;
    this.#activeJoinNonce = null;
    this.#activeJoinStartedAt = null;
    this.#replaceSnapshot({ joinError: null, pendingJoinRequest: false, phase: "meeting" });

    if (!this.#didEmitJoin) {
      this.#didEmitJoin = true;
      this.#options.onJoin?.({
        roomId: this.#options.roomId,
        displayName: this.#snapshot.joinSettings.displayName,
        role: this.#options.role,
        joinedAt,
      });
    }
  }

  #finalizeMeeting(): void {
    if (this.#didEmitEnd) return;

    this.#didEmitEnd = true;
    const endData = this.#buildEndData();
    this.#replaceSnapshot({ endData, phase: "end" });
    this.#options.onLeave?.();
    this.#options.onEnd?.(endData);
  }

  #buildEndData(): NativeMeetingEndData {
    const joinedAt = this.#joinedAt ?? new Date();
    const room = this.#roomState();
    return {
      roomId: this.#options.roomId,
      roomName: this.#options.roomName || room.roomName || this.#options.roomId,
      durationSeconds: Math.max(0, Math.round((Date.now() - joinedAt.getTime()) / 1000)),
      participantCount: this.#options.participantCount,
      chatCount: this.#options.chatCount,
      transcriptCount: this.#options.transcriptCount,
    };
  }

  #resolveJoinDisconnectMessage(): string {
    const closeReason = this.#session.getDiagnosticsSnapshot().websocketLastClose?.reason?.trim();
    if (closeReason) return `Unable to finish joining: ${closeReason}`;
    return "Unable to finish joining the room. Please retry.";
  }

  #defaultSettings(): NativeJoinSettings {
    return resolveNativeJoinDefaults({
      initialJoinSettings: this.#options.initialJoinSettings,
      simulatorMediaDisabled: this.#options.simulatorMediaDisabled,
      userName: this.#options.userName,
    });
  }

  #roomState(): RoomState {
    return this.#session.room.getState();
  }

  #replaceSnapshot(patch: Partial<NativeVideoConferenceControllerSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #notifyDiagnostics(): void {
    const room = this.#roomState();
    const snapshot: NativeVideoConferenceDiagnosticsSnapshot = {
      phase: this.#snapshot.phase,
      roomId: this.#options.roomId,
      roomName: this.#options.roomName || room.roomName || this.#options.roomId,
      joinNonce: this.#snapshot.joinNonce,
      pendingJoinRequest: this.#snapshot.pendingJoinRequest,
      activeJoinNonce: this.#activeJoinNonce,
      lastJoinError: this.#snapshot.joinError,
      connectionStatus: room.status,
      isConnected: room.status === "connected",
      isJoining: room.isJoining,
      session: this.#session.getDiagnosticsSnapshot(),
      meetingRoom: this.#snapshot.meetingRoomDiagnostics,
    };
    const signature = JSON.stringify(snapshot);
    if (signature === this.#lastDiagnosticsSignature) return;
    this.#lastDiagnosticsSignature = signature;
    this.#options.onDiagnosticsChange?.(snapshot);
  }

  #clearJoinGuardTimer(): void {
    if (this.#joinGuardTimer === undefined) return;
    clearTimeout(this.#joinGuardTimer);
    this.#joinGuardTimer = undefined;
  }
}
