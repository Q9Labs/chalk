import { Effect, type ManagedRuntime } from "effect";
import { MediaService } from "../effect/services/media-service";
import { ParticipantService } from "../effect/services/participant-service";
import { RoomService } from "../effect/services/room-service";
import type { ParticipantState } from "../effect/schemas/manager-state";
import type { ChatManager } from "../managers/chat-manager";
import type { InteractionManager } from "../managers/interaction-manager";
import type { RecordingManager } from "../managers/recording-manager";
import type { ScreenAnnotationsManager } from "../managers/screen-annotations-manager";
import type { ScreenShareManager } from "../managers/screen-share-manager";
import type { WhiteboardManager } from "../managers/whiteboard-manager";
import type { ConferenceSession } from "../room";
import type { Participant } from "../types.ts";
import type { MediaSessionApi, ParticipantSessionApi, RoomSessionApi, SessionStateUpdaters } from "./chalk-session-state";
import { wideEvents } from "../wide-events/index.ts";

interface AttachRoomBridgeArgs {
  room: ConferenceSession;
  setCurrentRoom: (room: ConferenceSession) => void;
  roomApi: RoomSessionApi;
  participantsApi: ParticipantSessionApi;
  mediaApi: MediaSessionApi;
  stateUpdaters: SessionStateUpdaters;
  runtime: ManagedRuntime.ManagedRuntime<RoomService | ParticipantService | MediaService, never>;
  screenShare: ScreenShareManager;
  annotations: ScreenAnnotationsManager;
  chat: ChatManager;
  recording: RecordingManager;
  interactions: InteractionManager;
  whiteboard: WhiteboardManager;
  startRecording: () => Promise<string>;
  stopRecording: () => Promise<void>;
}

const createShareSessionId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `share_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeParticipant = (participant: Participant): ParticipantState["participants"][number] => ({
  id: participant.id,
  displayName: participant.displayName,
  role: participant.role ?? "participant",
  isLocal: participant.isLocal,
  videoEnabled: participant.videoEnabled ?? false,
  audioEnabled: participant.audioEnabled ?? false,
  isScreenSharing: participant.isScreenSharing ?? false,
  isSpeaking: participant.isSpeaking ?? false,
  handRaised: participant.handRaised ?? false,
  connectionQuality: participant.connectionQuality ?? 100,
  videoTrack: participant.videoTrack ?? undefined,
  audioTrack: participant.audioTrack ?? undefined,
  screenShareTrack: participant.screenShareTrack ?? undefined,
  screenShareAudioTrack: participant.screenShareAudioTrack ?? undefined,
  joinedAt: participant.joinedAt,
  metadata: participant.metadata,
});

export const attachRoomToManagersAndBridgeState = ({ room, setCurrentRoom, roomApi, participantsApi, mediaApi, stateUpdaters, runtime, screenShare, annotations, chat, recording, interactions, whiteboard, startRecording, stopRecording }: AttachRoomBridgeArgs): (() => void) => {
  setCurrentRoom(room);

  screenShare.attachRoom(room);
  annotations.attachRoom(room);
  chat.attachRoom(room);
  recording.attachRoom(room);
  interactions.attachRoom(room);
  whiteboard.attachRoom(room);

  runtime
    .runPromise(
      Effect.gen(function* () {
        const roomSvc = yield* RoomService;
        const participantSvc = yield* ParticipantService;
        const mediaSvc = MediaService;

        yield* roomSvc.joinComplete(room);
        yield* participantSvc.attachRoom(room);
        yield* mediaSvc.pipe(Effect.andThen((ms) => ms.attachRoom(room)));
      }),
    )
    .catch(() => {
      // ConferenceSession attachment failed - error already emitted via wide events in client
    });

  recording.setApiCallbacks(startRecording, stopRecording);

  const screenShareUnsubscribers: Array<() => void> = [];

  screenShareUnsubscribers.push(
    screenShare.on("started", ({ participantId, isLocal }) => {
      const ctx = wideEvents.start("annotations.bridge.share-started");
      ctx.merge({
        participantId,
        isLocal,
      });
      if (!isLocal) {
        ctx.complete("success", { result: "ignored_remote_share" });
        return;
      }

      const shareSessionId = createShareSessionId();
      annotations.startSession(shareSessionId, participantId);

      if (screenShare.consumeAnnotationAutoOpen()) {
        annotations.open();
        ctx.complete("success", {
          shareSessionId,
          result: "started_and_opened",
        });
      } else {
        annotations.close();
        ctx.complete("success", {
          shareSessionId,
          result: "started_and_closed",
        });
      }
    }),
  );

  screenShareUnsubscribers.push(
    screenShare.on("stopped", () => {
      const ctx = wideEvents.start("annotations.bridge.share-stopped");
      const annotationState = annotations.getState();
      if (!annotationState.shareSessionId) {
        annotations.close();
        ctx.complete("success", {
          result: "closed_without_session",
        });
        return;
      }

      if (room.localParticipant?.id === annotationState.sharerParticipantId) {
        annotations.endSession(annotationState.shareSessionId);
      }

      annotations.close();
      ctx.complete("success", {
        shareSessionId: annotationState.shareSessionId,
        sharerParticipantId: annotationState.sharerParticipantId,
        result:
          room.localParticipant?.id === annotationState.sharerParticipantId
            ? "ended_local_session"
            : "closed_remote_session",
      });
    }),
  );

  const bridgeCleanup = bridgeRoomToSessionState({
    room,
    roomApi,
    participantsApi,
    mediaApi,
    stateUpdaters,
  });

  return () => {
    bridgeCleanup();

    for (const unsubscribe of screenShareUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best effort cleanup
      }
    }
  };
};

interface BridgeRoomToSessionStateArgs {
  room: ConferenceSession;
  roomApi: RoomSessionApi;
  participantsApi: ParticipantSessionApi;
  mediaApi: MediaSessionApi;
  stateUpdaters: SessionStateUpdaters;
}

const bridgeRoomToSessionState = ({ room, roomApi, participantsApi, mediaApi, stateUpdaters }: BridgeRoomToSessionStateArgs): (() => void) => {
  const { updateRoomState, updateParticipantState, updateMediaState } = stateUpdaters;
  const unsubscribers: Array<() => void> = [];

  updateRoomState({
    status: room.status,
    roomId: room.id,
    roomName: room.info?.name ?? null,
    isJoining: false,
    hostId: null,
  });

  const participants = Array.from(room.participants.values()).map(normalizeParticipant);
  const localParticipant = room.localParticipant ? normalizeParticipant(room.localParticipant) : null;
  const initialParticipants = localParticipant ? [...participants.filter((participant) => participant.id !== localParticipant.id), localParticipant] : participants;

  updateParticipantState({
    participants: initialParticipants,
    localParticipant,
    activeSpeaker: null,
    count: initialParticipants.length,
  });

  if (localParticipant) {
    updateMediaState({
      isVideoEnabled: localParticipant.videoEnabled,
      isAudioEnabled: localParticipant.audioEnabled,
      isTogglingVideo: false,
      isTogglingAudio: false,
      selectedCamera: null,
      selectedMicrophone: null,
      selectedSpeaker: null,
      devices: [],
    });
  }

  unsubscribers.push(
    room.on("connection.state.changed", (status) => {
      updateRoomState({
        status,
        roomId: room.id,
        roomName: room.info?.name ?? null,
        isJoining: false,
        hostId: null,
      });
      roomApi._emitter.emit("status:changed", { status });
    }),
  );

  unsubscribers.push(
    room.on("participant.joined", (participant) => {
      const normalized = normalizeParticipant(participant);
      const currentState = participantsApi._state;
      const updatedParticipants = [...currentState.participants.filter((p) => p.id !== normalized.id), normalized];

      updateParticipantState({
        ...currentState,
        participants: updatedParticipants,
        count: updatedParticipants.length,
      });

      participantsApi._emitter.emit("participant:joined", { participant: normalized });
    }),
  );

  unsubscribers.push(
    room.on("participant.left", (participantId) => {
      const currentState = participantsApi._state;
      const updatedParticipants = currentState.participants.filter((participant) => participant.id !== participantId);

      updateParticipantState({
        ...currentState,
        participants: updatedParticipants,
        count: updatedParticipants.length,
      });

      participantsApi._emitter.emit("participant:left", { participantId });
    }),
  );

  unsubscribers.push(
    room.on("participant.updated", ({ participantId, participant }) => {
      const normalized = normalizeParticipant(participant);
      const currentState = participantsApi._state;
      const existingIndex = currentState.participants.findIndex((currentParticipant) => currentParticipant.id === participantId || currentParticipant.id === normalized.id);
      const updatedParticipants = existingIndex === -1 ? [...currentState.participants, normalized] : currentState.participants.map((currentParticipant) => (currentParticipant.id === participantId || currentParticipant.id === normalized.id ? normalized : currentParticipant));

      const localParticipant = normalized.isLocal ? normalized : currentState.localParticipant;

      updateParticipantState({
        ...currentState,
        participants: updatedParticipants,
        count: updatedParticipants.length,
        localParticipant,
      });

      participantsApi._emitter.emit("participant:updated", { participantId, participant: normalized });

      if (normalized.isLocal) {
        const currentMediaState = mediaApi._state;
        updateMediaState({
          ...currentMediaState,
          isVideoEnabled: normalized.videoEnabled,
          isAudioEnabled: normalized.audioEnabled,
        });
      }
    }),
  );

  unsubscribers.push(
    room.on("speaker.active.changed", (speaker) => {
      const normalized = speaker ? normalizeParticipant(speaker) : null;
      const currentState = participantsApi._state;

      updateParticipantState({
        ...currentState,
        activeSpeaker: normalized,
      });

      participantsApi._emitter.emit("active-speaker:changed", { participant: normalized });
    }),
  );

  unsubscribers.push(
    room.on("connection.state.changed", (status) => {
      if (status === "connected") {
        roomApi._emitter.emit("connected", { roomId: room.id });
      } else if (status === "disconnected") {
        roomApi._emitter.emit("disconnected", { reason: "connection_lost" });
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best effort cleanup
      }
    }
  };
};
