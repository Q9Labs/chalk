/**
 * ConferenceSession class - main interface for interacting with a video room.
 * Orchestrates composable modules for media, signaling, interactions, and leave flow.
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import { EventEmitter } from "./events.ts";
import type { ChatMessage, MediaDevice, Participant, ReactionEmoji, ScreenShareOptions, SessionConnectionState, SessionInfo, TenantConfig, TokenSet } from "./types.ts";
import { wideEvents } from "./wide-events/index.ts";
import { WideEventContext } from "./wide-events/context.ts";
import type { WSClient } from "./ws-client.ts";
import type { APIClient } from "./api-client.ts";
import { createConferenceSessionDeviceController } from "./conference-session/device-controls.ts";
import { createConferenceSessionInteractionActions } from "./conference-session/interaction-actions.ts";
import { createConferenceSessionLeaveFlow } from "./conference-session/leave-flow.ts";
import { createConferenceSessionMediaController } from "./conference-session/media-controls.ts";
import { createConferenceSessionStore, type ConferenceSessionStore } from "./conference-session/session-store.ts";
import { setupConferenceSessionRtkSignaling } from "./conference-session/rtk-signaling.ts";
import type { ConferenceSessionEvents, Transcript } from "./conference-session/types.ts";
import { createConferenceSessionAnnotationActions } from "./conference-session/annotation-actions.ts";
import { createConferenceSessionWhiteboardActions } from "./conference-session/whiteboard-actions.ts";
import { createHostAudioCommandHandler, setupConferenceSessionWsSignaling } from "./conference-session/ws-signaling.ts";
import type { ScreenAnnotationAccessMode, ScreenAnnotationItem, ScreenAnnotationTool } from "./types/entities/annotations.ts";
import type { VideoBackgroundEffect } from "./types/entities/media.ts";

export type { ConferenceSessionEvents, Transcript } from "./conference-session/types.ts";

export class ConferenceSession extends EventEmitter<ConferenceSessionEvents> {
  readonly id: string;

  private _connectionState: SessionConnectionState = "disconnected";
  private _info: SessionInfo | null = null;
  private _participants = new Map<string, Participant>();
  private _rtkPeerIdToStableId = new Map<string, string>();
  private _localParticipant: Participant | null = null;
  private _activeSpeaker: Participant | null = null;
  private _messages: ChatMessage[] = [];
  private _transcripts: Transcript[] = [];
  private _currentRecording: { id: string } | null = null;
  private _tokens: TokenSet | null = null;
  private _whiteboardPermissions = new Map<string, boolean>();
  private _whiteboardDefaultAccess = true;
  private _annotationShareSessionId: string | null = null;
  private _annotationSharerParticipantId: string | null = null;
  private _annotationAccessMode: ScreenAnnotationAccessMode = "all";
  private _roomCreated = false;
  private _tenantConfig: TenantConfig | null = null;
  private _roomSyncReadyEmitted = false;

  private rtkClient?: RealtimeKitClient;
  private wsClient?: WSClient;
  private apiClient?: APIClient;
  private readonly debug: boolean;
  private readonly sessionStore: ConferenceSessionStore;
  private wsSignalingCleanup: (() => void) | null = null;

  private readonly leaveState: { isLeaving: boolean; leavePromise: Promise<void> | null } = {
    isLeaving: false,
    leavePromise: null,
  };

  private readonly hostAudioCommandHandler: (participantId: string, enable: boolean) => Promise<void>;
  private readonly mediaController: ReturnType<typeof createConferenceSessionMediaController>;
  private readonly deviceController: ReturnType<typeof createConferenceSessionDeviceController>;
  private readonly interactionActions: ReturnType<typeof createConferenceSessionInteractionActions>;
  private readonly annotationActions: ReturnType<typeof createConferenceSessionAnnotationActions>;
  private readonly whiteboardActions: ReturnType<typeof createConferenceSessionWhiteboardActions>;
  private readonly leaveFlow: ReturnType<typeof createConferenceSessionLeaveFlow>;

  constructor(roomId: string, wsClientOrRtkClient?: WSClient | RealtimeKitClient, debug = false, apiClient?: APIClient) {
    super();
    this.id = roomId;
    this.debug = debug;
    this.apiClient = apiClient;
    this.sessionStore = createConferenceSessionStore({
      getParticipants: () => this._participants,
      getPeerIdMap: () => this._rtkPeerIdToStableId,
      getMessages: () => this._messages,
      setMessages: (messages) => {
        this._messages = messages;
      },
      getTranscripts: () => this._transcripts,
      setTranscripts: (transcripts) => {
        this._transcripts = transcripts;
      },
      getWhiteboardPermissions: () => this._whiteboardPermissions,
      getLocalParticipant: () => this._localParticipant,
      setLocalParticipant: (participant) => {
        this._localParticipant = participant;
      },
      getActiveSpeaker: () => this._activeSpeaker,
      setActiveSpeaker: (participant) => {
        this._activeSpeaker = participant;
      },
      getCurrentRecording: () => this._currentRecording,
      setCurrentRecording: (recording) => {
        this._currentRecording = recording;
      },
    });

    this.hostAudioCommandHandler = createHostAudioCommandHandler({
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      getRtkClient: () =>
        this.rtkClient
          ? (this.rtkClient as unknown as {
              self: {
                audioEnabled: boolean;
                audioTrack?: MediaStreamTrack;
                enableAudio: () => Promise<void>;
                disableAudio: () => Promise<void>;
              };
            })
          : null,
      emitParticipantUpdated: (participantId, participant) => this.emitParticipantUpdated(participantId, participant),
      emitError: (error) => this.emit("error", error),
    });

    this.mediaController = createConferenceSessionMediaController({
      getRtkClient: () => this.rtkClient,
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      emitError: (error) => this.emit("error", error),
      emitParticipantUpdated: (participantId, participant) => this.emitParticipantUpdated(participantId, participant),
    });

    this.deviceController = createConferenceSessionDeviceController({
      getRtkClient: () => this.rtkClient,
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      emitError: (error) => this.emit("error", error),
      reapplyBackgroundEffect: () => this.mediaController.reapplyBackgroundEffect(),
    });

    this.interactionActions = createConferenceSessionInteractionActions({
      getWsClient: () => this.wsClient,
      getRtkClient: () => this.rtkClient,
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      emitChatMessage: (message) => this.pushAndEmitChatMessage(message),
      emitParticipantUpdated: (participantId, participant) => this.emitParticipantUpdated(participantId, participant),
      emitHandRaised: (participantId) => this.emit("hand.raised", { participantId }),
      emitHandLowered: (participantId) => this.emit("hand.lowered", { participantId }),
    });

    this.whiteboardActions = createConferenceSessionWhiteboardActions({
      getWsClient: () => this.wsClient,
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      getParticipants: () => this.sessionStore.getParticipants(),
      getWhiteboardPermission: (participantId) => this.sessionStore.getWhiteboardPermission(participantId),
      getDefaultWhiteboardAccess: () => this._whiteboardDefaultAccess,
    });

    this.annotationActions = createConferenceSessionAnnotationActions({
      getWsClient: () => this.wsClient,
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      getCurrentAccessMode: () => this._annotationAccessMode,
      getCurrentShareSessionId: () => this._annotationShareSessionId,
      getCurrentSharerParticipantId: () => this._annotationSharerParticipantId,
    });

    this.leaveFlow = createConferenceSessionLeaveFlow({
      roomId: this.id,
      state: this.leaveState,
      getWsClient: () => this.wsClient,
      getRtkClient: () => this.rtkClient,
      clearRuntimeState: () => this.clearRuntimeState(),
      setDisconnected: () => this._setConnectionState("disconnected"),
    });

    if (wsClientOrRtkClient) {
      if ("connect" in wsClientOrRtkClient) {
        this.wsClient = wsClientOrRtkClient as WSClient;
        this.setupWSListeners();
      } else {
        this.rtkClient = wsClientOrRtkClient as RealtimeKitClient;
        this.setupRTKListeners();
      }
    }
  }

  get connectionState(): SessionConnectionState {
    return this._connectionState;
  }

  get status(): SessionConnectionState {
    return this.connectionState;
  }

  get info(): SessionInfo | null {
    return this._info;
  }

  get participants(): Map<string, Participant> {
    return new Map(this.sessionStore.getParticipants());
  }

  get localParticipant(): Participant | null {
    return this.sessionStore.getLocalParticipant();
  }

  get activeSpeaker(): Participant | null {
    return this.sessionStore.getActiveSpeaker();
  }

  get messages(): ChatMessage[] {
    return [...this.sessionStore.getMessages()];
  }

  get transcripts(): Transcript[] {
    return [...this.sessionStore.getTranscripts()];
  }

  get isRecording(): boolean {
    return this.sessionStore.getCurrentRecording() !== null;
  }

  get roomCreated(): boolean {
    return this._roomCreated;
  }

  get tenantConfig(): TenantConfig | null {
    return this._tenantConfig;
  }

  get tokens(): TokenSet | null {
    return this._tokens;
  }

  get rtkMeeting(): RealtimeKitClient | undefined {
    return this.rtkClient;
  }

  debugDumpParticipants(): void {
    // no-op: wide events and devtools provide better debugging paths
  }

  private logConnectionState(): void {
    // no-op: canonical connection telemetry is emitted via wide-events
  }

  private validateTrack(track: MediaStreamTrack | undefined | null, _type: string, _participantId: string): boolean {
    return this.mediaController.validateMediaTrack(track);
  }

  private pushAndEmitChatMessage(message: ChatMessage): void {
    this.sessionStore.appendMessage(message);
    this.emit("chat.message", message);
  }

  private emitParticipantUpdated(participantId: string, participant: Participant): void {
    this.sessionStore.setParticipant(participantId, participant);
    this.emit("participant.updated", { participantId, participant });
  }

  private clearRuntimeState(): void {
    this.wsSignalingCleanup?.();
    this.wsSignalingCleanup = null;
    this.sessionStore.clearRuntimeState();
  }

  private emitRoomSyncReady(source: "rtk.snapshot" | "ws.snapshot", participantCount: number): void {
    if (this._roomSyncReadyEmitted) {
      return;
    }
    this._roomSyncReadyEmitted = true;

    const ctx = new WideEventContext("room.sync.ready", wideEvents.collector);
    ctx.merge({
      source,
      roomId: this.id,
      participantCount,
      transport: this.rtkClient && this.wsClient ? "rtk+ws" : this.rtkClient ? "rtk" : "ws",
    });
    ctx.complete("success");
  }

  private setupWSListeners(): void {
    this.wsSignalingCleanup?.();
    this.wsSignalingCleanup = setupConferenceSessionWsSignaling({
      roomId: this.id,
      getWsClient: () => this.wsClient,
      hasRtkClient: () => !!this.rtkClient,
      setConnectionState: (state) => this._setConnectionState(state),
      getParticipants: () => this.sessionStore.getParticipants(),
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      getCurrentRecording: () => this.sessionStore.getCurrentRecording(),
      appendMessage: (message) => this.sessionStore.appendMessage(message),
      getMessages: () => this.sessionStore.getMessages(),
      setMessages: (messages) => this.sessionStore.setMessages(messages),
      setWhiteboardPermission: (participantId, canDraw) => {
        this.sessionStore.setWhiteboardPermission(participantId, canDraw);
      },
      setAnnotationSession: (shareSessionId, sharerParticipantId) => {
        this._setAnnotationSession(shareSessionId, sharerParticipantId);
      },
      setAnnotationAccessMode: (accessMode) => {
        this._setAnnotationAccessMode(accessMode);
      },
      setCurrentRecording: (recording) => {
        this.sessionStore.setCurrentRecording(recording);
      },
      emitRoomSyncReady: (source, participantCount) => this.emitRoomSyncReady(source, participantCount),
      emit: (event, data) => {
        this.emit(event, data);
      },
      handleHostAudioCommand: this.hostAudioCommandHandler,
    });
  }

  private setupRTKListeners(): void {
    setupConferenceSessionRtkSignaling({
      roomId: this.id,
      debug: this.debug,
      isLeaving: () => this.leaveState.isLeaving,
      getRtkClient: () => this.rtkClient,
      getWsClient: () => this.wsClient,
      getParticipants: () => this.sessionStore.getParticipants(),
      getPeerIdMap: () => this.sessionStore.getPeerIdMap(),
      getLocalParticipant: () => this.sessionStore.getLocalParticipant(),
      getActiveSpeaker: () => this.sessionStore.getActiveSpeaker(),
      setActiveSpeaker: (participant) => {
        this.sessionStore.setActiveSpeaker(participant);
      },
      getMessages: () => this.sessionStore.getMessages(),
      getTranscripts: () => this.sessionStore.getTranscripts(),
      setConnectionState: (state) => this._setConnectionState(state),
      emitRoomSyncReady: (source, participantCount) => this.emitRoomSyncReady(source, participantCount),
      emit: (event, data) => {
        this.emit(event, data);
      },
      validateTrack: (track, type, participantId) => this.validateTrack(track, type, participantId),
      logConnectionState: () => this.logConnectionState(),
    });
  }

  _setConnectionState(state: SessionConnectionState): void {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.emit("connection.state.changed", state);
    }
  }

  _setStatus(status: SessionConnectionState): void {
    this._setConnectionState(status);
  }

  _setInfo(info: SessionInfo): void {
    this._info = info;
  }

  _setLocalParticipant(participant: Participant): void {
    this.sessionStore.setLocalParticipant(participant);
    this.sessionStore.setParticipant(participant.id, participant);
  }

  _setTokens(tokens: TokenSet): void {
    this._tokens = tokens;
  }

  _setRoomCreated(created: boolean): void {
    this._roomCreated = created;
  }

  _setTenantConfig(config: TenantConfig | null): void {
    this._tenantConfig = config;
  }

  attachWsClient(wsClient: WSClient): void {
    if (this.wsClient === wsClient) {
      return;
    }
    this.wsClient = wsClient;
    this.setupWSListeners();
  }

  async toggleVideo(): Promise<boolean> {
    return this.mediaController.toggleVideo();
  }

  async toggleAudio(): Promise<boolean> {
    return this.mediaController.toggleAudio();
  }

  async startScreenShare(options?: ScreenShareOptions): Promise<boolean> {
    return this.mediaController.startScreenShare(options);
  }

  async stopScreenShare(): Promise<void> {
    await this.mediaController.stopScreenShare();
  }

  async applyBackgroundEffect(effect: VideoBackgroundEffect): Promise<boolean> {
    return this.mediaController.applyBackgroundEffect(effect);
  }

  async clearBackgroundEffect(): Promise<boolean> {
    return this.mediaController.clearBackgroundEffect();
  }

  async getDevices(): Promise<MediaDevice[]> {
    return this.deviceController.getDevices();
  }

  async getCameras(): Promise<MediaDevice[]> {
    return this.deviceController.getCameras();
  }

  async getMicrophones(): Promise<MediaDevice[]> {
    return this.deviceController.getMicrophones();
  }

  async getSpeakers(): Promise<MediaDevice[]> {
    return this.deviceController.getSpeakers();
  }

  async selectCamera(deviceId: string): Promise<boolean> {
    return this.deviceController.selectCamera(deviceId);
  }

  async selectMicrophone(deviceId: string): Promise<boolean> {
    return this.deviceController.selectMicrophone(deviceId);
  }

  sendMessage(content: string, attachmentIds?: string[]): void {
    this.interactionActions.sendMessage(content, attachmentIds);
  }

  markChatRead(readThroughMessageId: string): void {
    this.interactionActions.markChatRead(readThroughMessageId);
  }

  sendReaction(emoji: ReactionEmoji): void {
    this.interactionActions.sendReaction(emoji);
  }

  raiseHand(): void {
    this.interactionActions.raiseHand();
  }

  lowerHand(): void {
    this.interactionActions.lowerHand();
  }

  muteParticipant(participantId: string): void {
    this.interactionActions.muteParticipant(participantId);
  }

  unmuteParticipant(participantId: string): void {
    this.interactionActions.unmuteParticipant(participantId);
  }

  updateLocalParticipantDisplayName(displayName: string): void {
    const trimmedDisplayName = displayName.trim();
    const localParticipant = this.sessionStore.getLocalParticipant();
    if (!localParticipant || !trimmedDisplayName) {
      return;
    }

    const updatedParticipant: Participant = {
      ...localParticipant,
      displayName: trimmedDisplayName,
    };

    this.sessionStore.setLocalParticipant(updatedParticipant);
    this.sessionStore.setParticipant(updatedParticipant.id, updatedParticipant);
    this.emit("participant.updated", {
      participantId: updatedParticipant.id,
      participant: updatedParticipant,
    });
  }

  canDrawWhiteboard(participantId?: string): boolean {
    return this.whiteboardActions.canDrawWhiteboard(participantId);
  }

  grantWhiteboardPermission(participantId: string): void {
    this.whiteboardActions.grantWhiteboardPermission(participantId);
  }

  revokeWhiteboardPermission(participantId: string): void {
    this.whiteboardActions.revokeWhiteboardPermission(participantId);
  }

  sendWhiteboardUpdateV2(payload: { sceneId: string; syncAll: boolean; elements: unknown[]; seq?: number }): void {
    this.whiteboardActions.sendWhiteboardUpdateV2(payload);
  }

  sendWhiteboardCursor(x: number, y: number): void {
    this.whiteboardActions.sendWhiteboardCursor(x, y);
  }

  clearWhiteboard(): void {
    this.whiteboardActions.clearWhiteboard();
  }

  requestWhiteboardSync(): void {
    this.whiteboardActions.requestWhiteboardSync();
  }

  openWhiteboard(): void {
    this.whiteboardActions.openWhiteboard();
  }

  closeWhiteboard(): void {
    this.whiteboardActions.closeWhiteboard();
  }

  canDrawAnnotations(participantId?: string): boolean {
    return this.annotationActions.canDrawAnnotations(participantId);
  }

  startAnnotationSession(shareSessionId: string, accessMode?: ScreenAnnotationAccessMode): void {
    this.annotationActions.startAnnotationSession(shareSessionId, accessMode);
  }

  endAnnotationSession(shareSessionId?: string): void {
    this.annotationActions.endAnnotationSession(shareSessionId);
  }

  requestAnnotationSync(): void {
    this.annotationActions.requestAnnotationSync();
  }

  sendAnnotationUpdate(payload: { shareSessionId: string; sharerParticipantId: string; syncAll: boolean; items: ScreenAnnotationItem[]; seq?: number }): void {
    this.annotationActions.sendAnnotationUpdate(payload);
  }

  sendAnnotationCursor(payload: { shareSessionId: string; tool: ScreenAnnotationTool; x: number; y: number }): void {
    this.annotationActions.sendAnnotationCursor(payload);
  }

  clearAnnotations(shareSessionId?: string): void {
    this.annotationActions.clearAnnotations(shareSessionId);
  }

  setAnnotationAccessMode(accessMode: ScreenAnnotationAccessMode, shareSessionId?: string): void {
    this.annotationActions.setAnnotationAccessMode(accessMode, shareSessionId);
  }

  _setAnnotationSession(shareSessionId: string | null, sharerParticipantId: string | null): void {
    this._annotationShareSessionId = shareSessionId;
    this._annotationSharerParticipantId = sharerParticipantId;
  }

  _setAnnotationAccessMode(accessMode: ScreenAnnotationAccessMode): void {
    this._annotationAccessMode = accessMode;
  }

  async leave(): Promise<void> {
    return this.leaveFlow.leave();
  }

  async updateDisplayName(displayName: string): Promise<void> {
    const localParticipant = this.localParticipant;
    if (!localParticipant) {
      throw new Error("No local participant");
    }

    if (this.apiClient) {
      const response = await this.apiClient.updateParticipant(this.id, "me", { displayName });
      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to update display name");
      }
    }

    // Update local state immediately
    localParticipant.displayName = displayName;
    this._setLocalParticipant(localParticipant);
    this.emitParticipantUpdated(localParticipant.id, localParticipant);
  }
}
