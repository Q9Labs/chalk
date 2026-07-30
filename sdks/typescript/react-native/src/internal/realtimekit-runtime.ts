import { correlateNativeTransports } from "../runtime/transport-correlation";
import type { NativeSessionTelemetry } from "../telemetry";
import type { ChalkError, ChalkSessionConfig, ChalkSessionDiagnosticsSnapshot, IncidentConfig, JoinOptions, LeaveOptions } from "./core";
import { ChalkErrorClass } from "./core";
import { requestRealtimeKitToken } from "./realtimekit-admission";
import { MediaManager, ScreenShareManager } from "./realtimekit-media-managers";
import { isRealtimeKitModule, listen, socketConnectionState, type RealtimeKitMeeting, type RealtimeKitModule } from "./realtimekit-ports";
import { connectionState, ParticipantsManager, RoomManager, UIManager } from "./realtimekit-room-managers";
import { unavailable, unavailableChatManager, unavailableInteractionManager, unavailableRecordingManager, unavailableWhiteboardManager } from "./realtimekit-unavailable-managers";

type SessionEvent = "connected" | "disconnected" | "error";
type ConnectionEventHandler = () => void;
type ErrorEventHandler = (error: ChalkError) => void;
type SessionEventHandler = ConnectionEventHandler | ErrorEventHandler;

export class ChalkSession {
  readonly telemetry: NativeSessionTelemetry | undefined;
  readonly room = new RoomManager();
  readonly participants = new ParticipantsManager();
  readonly media = new MediaManager();
  readonly screenShare = new ScreenShareManager();
  readonly interactions = unavailableInteractionManager();
  readonly chat = unavailableChatManager();
  readonly recording = unavailableRecordingManager();
  readonly ui = new UIManager();
  readonly whiteboard = unavailableWhiteboardManager();

  readonly #config: ChalkSessionConfig;
  readonly #eventHandlers = new Map<SessionEvent, Set<SessionEventHandler>>();
  readonly #stopTransportCorrelation: (() => void) | undefined;
  #cleanups: (() => void)[] = [];
  #disposed = false;
  #joinGeneration = 0;
  #joinPromise: Promise<void> | null = null;
  #meeting: RealtimeKitMeeting | null = null;
  #remoteParticipantCleanups = new Map<string, { readonly participant: object; readonly cleanup: () => void }>();

  constructor(config: ChalkSessionConfig) {
    this.#config = config;
    this.telemetry = config.telemetry;
    this.#stopTransportCorrelation = config.telemetry
      ? correlateNativeTransports({
          apiUrl: config.apiUrl,
          credentials: [config.token, config.apiKey].filter((credential): credential is string => Boolean(credential)),
          dynamicCredentials: config.dynamicTransportCredentials,
          wsUrl: config.wsUrl,
          telemetry: config.telemetry,
        })
      : undefined;
  }

  configureIncident(_config?: IncidentConfig): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#joinGeneration += 1;
    const meeting = this.#meeting;
    this.#detachMeeting();
    if (meeting) void meeting.leave().catch(() => undefined);
    this.#stopTransportCorrelation?.();
  }

  async preloadRealtimeKit(): Promise<void> {
    await this.#loadRealtimeKit();
  }

  on(event: "error", handler: ErrorEventHandler): () => void;
  on(event: "connected" | "disconnected", handler: ConnectionEventHandler): () => void;
  on(event: SessionEvent, handler: SessionEventHandler): () => void {
    const handlers = this.#eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#eventHandlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  join(roomId: string, options: JoinOptions): Promise<void> {
    if (this.#disposed) return Promise.reject(new ChalkErrorClass("The native session is disposed"));
    if (this.#meeting && this.room.getState().status === "connected") return Promise.resolve();
    if (this.#joinPromise) return this.#joinPromise;

    this.room.connecting(roomId);
    const generation = ++this.#joinGeneration;
    const promise = this.#join(roomId, options, generation).finally(() => {
      if (this.#joinPromise === promise) this.#joinPromise = null;
    });
    this.#joinPromise = promise;
    return promise;
  }

  async leave(_options?: LeaveOptions): Promise<void> {
    this.#joinGeneration += 1;
    const meeting = this.#meeting;
    this.#joinPromise = null;
    this.#detachMeeting();
    if (meeting) await meeting.leave();
    this.room.disconnected();
    this.#emit("disconnected");
  }

  createSession(_name?: string): Promise<string> {
    return Promise.reject(unavailable("Meeting creation"));
  }

  createJoinToken(_roomId?: string): Promise<{ joinToken: string }> {
    return Promise.reject(unavailable("Invite creation"));
  }

  endSession(_roomId: string): Promise<void> {
    return Promise.reject(unavailable("Ending a meeting for everyone"));
  }

  getDiagnosticsSnapshot(): ChalkSessionDiagnosticsSnapshot {
    return { websocketConnectionState: connectionState(this.room.getState().status) };
  }

  async updateOwnDisplayName(displayName: string): Promise<void> {
    const meeting = this.#requireMeeting();
    meeting.self.setName(displayName);
    this.participants.sync(meeting);
  }

  removeParticipant(_participantId: string): Promise<void> {
    return Promise.reject(unavailable("Participant removal without a canonical session store"));
  }

  muteParticipant(_participantId: string): void {
    throw unavailable("Participant moderation without a canonical session store");
  }

  unmuteParticipant(_participantId: string): void {
    throw unavailable("Directed media requests without a canonical session store");
  }

  async #join(roomId: string, options: JoinOptions, generation: number): Promise<void> {
    try {
      const previousMeeting = this.#meeting;
      if (previousMeeting) {
        this.#detachMeeting();
        await previousMeeting.leave().catch(() => undefined);
      }
      const [realtimeKit, accessToken] = await Promise.all([this.#loadRealtimeKit(), this.#getAccessToken()]);
      const authToken = await requestRealtimeKitToken({
        accessToken,
        apiUrl: this.#config.apiUrl,
        fetchImplementation: this.#config.fetch,
        options,
        roomId,
      });
      const meeting = await realtimeKit.init({
        authToken,
        defaults: {
          audio: options.audioEnabled !== false,
          video: options.videoEnabled !== false,
        },
        onError: (cause) => {
          if (generation === this.#joinGeneration) this.#handleMeetingError(cause);
        },
      });
      if (this.#disposed || generation !== this.#joinGeneration) {
        await meeting.leave().catch(() => undefined);
        throw new ChalkErrorClass("The native join was cancelled");
      }

      this.#meeting = meeting;
      this.participants.setLocalRole(options.role);
      this.#attachMeeting(meeting, roomId);
      meeting.self.setName(options.userName);
      await meeting.join();
      if (this.#disposed || generation !== this.#joinGeneration) {
        if (this.#meeting === meeting) {
          this.#detachMeeting();
          await meeting.leave().catch(() => undefined);
        }
        throw new ChalkErrorClass("The native join was cancelled");
      }
      this.room.connected(roomId, meeting);
      this.#syncMeetingState(meeting);
      this.#emit("connected");
    } catch (cause) {
      const error = ChalkErrorClass.wrap(cause);
      if (generation !== this.#joinGeneration) throw error;
      this.#detachMeeting();
      this.room.failed(roomId, error.message);
      this.#emit("error", error);
      throw error;
    }
  }

  #attachMeeting(meeting: RealtimeKitMeeting, roomId: string): void {
    const sync = () => this.#syncMeetingState(meeting);
    const disconnect = () => {
      if (meeting !== this.#meeting) return;
      this.#detachMeeting();
      this.room.disconnected(roomId);
      this.#emit("disconnected");
    };
    this.#cleanups = [
      listen(meeting.self, "audioUpdate", sync),
      listen(meeting.self, "videoUpdate", sync),
      listen(meeting.self, "screenShareUpdate", sync),
      listen(meeting.self, "deviceUpdate", sync),
      listen(meeting.self, "deviceListUpdate", sync),
      listen(meeting.self, "roomLeft", disconnect),
      listen(meeting.participants, "activeSpeaker", (value) => this.participants.setActiveSpeaker(meeting, value)),
      listen(meeting.participants.joined, "participantJoined", sync),
      listen(meeting.participants.joined, "participantLeft", sync),
      listen(meeting.participants.joined, "participantsUpdate", sync),
    ];
    if (meeting.meta) {
      this.#cleanups.push(
        listen(meeting.meta, "socketConnectionUpdate", (value) => {
          const state = socketConnectionState(value);
          const roomStatus = this.room.getState().status;
          if (state === "connected" && roomStatus === "reconnecting") this.room.connected(roomId, meeting);
          if (state === "reconnecting" && roomStatus === "connected") this.room.reconnecting();
          if ((state === "disconnected" || state === "failed") && (roomStatus === "connected" || roomStatus === "reconnecting")) disconnect();
        }),
      );
    }
    this.media.attach(meeting.self);
    this.screenShare.attach(meeting.self, sync);
  }

  #detachMeeting(): void {
    for (const cleanup of this.#cleanups) cleanup();
    this.#cleanups = [];
    for (const entry of this.#remoteParticipantCleanups.values()) entry.cleanup();
    this.#remoteParticipantCleanups.clear();
    this.media.detach();
    this.screenShare.detach();
    this.participants.reset();
    this.#meeting = null;
  }

  #syncMeetingState(meeting: RealtimeKitMeeting): void {
    if (meeting !== this.#meeting) return;
    this.#syncRemoteParticipantListeners(meeting);
    this.participants.sync(meeting);
    this.media.sync(meeting.self);
    this.screenShare.sync(meeting);
  }

  #syncRemoteParticipantListeners(meeting: RealtimeKitMeeting): void {
    const participants = meeting.participants.joined.toArray();
    const activeIds = new Set(participants.map((participant) => participant.id));
    for (const [participantId, entry] of this.#remoteParticipantCleanups) {
      if (activeIds.has(participantId)) continue;
      entry.cleanup();
      this.#remoteParticipantCleanups.delete(participantId);
    }
    for (const participant of participants) {
      const current = this.#remoteParticipantCleanups.get(participant.id);
      if (current?.participant === participant) continue;
      current?.cleanup();
      const cleanups = [listen(participant, "audioUpdate", () => this.#syncMeetingState(meeting)), listen(participant, "videoUpdate", () => this.#syncMeetingState(meeting)), listen(participant, "screenShareUpdate", () => this.#syncMeetingState(meeting))];
      this.#remoteParticipantCleanups.set(participant.id, {
        participant,
        cleanup: () => {
          for (const cleanup of cleanups) cleanup();
        },
      });
    }
  }

  #handleMeetingError(cause: unknown): void {
    const error = ChalkErrorClass.wrap(cause);
    const roomId = this.room.getState().roomId ?? "";
    this.room.failed(roomId, error.message);
    this.#emit("error", error);
  }

  async #loadRealtimeKit(): Promise<RealtimeKitModule> {
    const module = await this.#config.realtimeKitLoader?.();
    if (!isRealtimeKitModule(module)) throw unavailable("RealtimeKit media");
    return module;
  }

  async #getAccessToken(): Promise<string> {
    const token = this.#config.token?.trim() || (await this.#config.tokenProvider?.())?.trim();
    if (!token) throw new ChalkErrorClass("A Chalk access token is required to join");
    return token;
  }

  #requireMeeting(): RealtimeKitMeeting {
    if (!this.#meeting) throw new ChalkErrorClass("The native meeting is not connected");
    return this.#meeting;
  }

  #emit(event: "error", error: ChalkError): void;
  #emit(event: "connected" | "disconnected"): void;
  #emit(event: SessionEvent, error?: ChalkError): void {
    for (const handler of this.#eventHandlers.get(event) ?? []) {
      if (event === "error") {
        if (error) (handler as ErrorEventHandler)(error);
        continue;
      }
      (handler as ConnectionEventHandler)();
    }
  }
}
