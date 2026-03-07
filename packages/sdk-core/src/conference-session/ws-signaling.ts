import { wideEvents } from "../wide-events/index.ts";
import type { ChalkError, ChatMessage, Participant, Recording, SessionConnectionState } from "../types.ts";
import type { WSClient } from "../ws-client.ts";
import type { WSEvents } from "../ws-client/emitted-events.ts";
import type { ConferenceSessionEvents, WhiteboardCursorEvent, WhiteboardSnapshotEvent, WhiteboardUpdateEvent } from "./types.ts";

interface WsSignalingDeps {
  roomId: string;
  getWsClient: () => WSClient | undefined;
  hasRtkClient: () => boolean;
  setConnectionState: (state: SessionConnectionState) => void;
  getParticipants: () => Map<string, Participant>;
  getLocalParticipant: () => Participant | null;
  getCurrentRecording: () => { id: string } | null;
  appendMessage: (message: ChatMessage) => void;
  setWhiteboardPermission: (participantId: string, canDraw: boolean) => void;
  setCurrentRecording: (recording: { id: string } | null) => void;
  emitRoomSyncReady: (source: "rtk.snapshot" | "ws.snapshot", participantCount: number) => void;
  emit: <K extends keyof ConferenceSessionEvents>(event: K, data: ConferenceSessionEvents[K]) => void;
  handleHostAudioCommand: (participantId: string, enable: boolean) => Promise<void>;
}

export const setupConferenceSessionWsSignaling = (deps: WsSignalingDeps): (() => void) => {
  const wsClient = deps.getWsClient();
  if (!wsClient) {
    return () => {};
  }
  const unsubscribers: Array<() => void> = [];
  const subscribe = <K extends keyof WSEvents>(event: K, handler: (data: WSEvents[K]) => void): void => {
    unsubscribers.push(wsClient.on(event, handler));
  };

  subscribe("connected", () => {
    if (!deps.hasRtkClient()) {
      deps.setConnectionState("connected");
    }
  });

  subscribe("disconnected", () => {
    if (!deps.hasRtkClient()) {
      deps.setConnectionState("disconnected");
    }
  });

  subscribe("reconnecting", () => {
    if (!deps.hasRtkClient()) {
      deps.setConnectionState("reconnecting");
    }
  });

  if (!deps.hasRtkClient()) {
    subscribe("participant.joined", (data) => {
      const participants = deps.getParticipants();
      if (participants.has(data.id)) {
        return;
      }
      participants.set(data.id, data);
      deps.emit("participant.joined", data);
    });

    subscribe("participant.left", (data) => {
      const participants = deps.getParticipants();
      const participant = participants.get(data.participantId);
      participants.delete(data.participantId);
      if (participant) {
        deps.emit("participant.left", data.participantId);
      }
    });

    subscribe("participant.updated", (data) => {
      const participants = deps.getParticipants();
      const participant = participants.get(data.participantId);
      if (participant) {
        const updated = { ...participant, ...data.changes };
        participants.set(data.participantId, updated);
        deps.emit("participant.updated", {
          participantId: data.participantId,
          participant: updated,
        });
      }
    });
  }

  subscribe("participant.mute", (data) => {
    void deps.handleHostAudioCommand(data.participantId, false);
  });

  subscribe("participant.unmute", (data) => {
    void deps.handleHostAudioCommand(data.participantId, true);
  });

  subscribe("chat.message", (data) => {
    deps.appendMessage(data as ChatMessage);
    deps.emit("chat.message", data as ChatMessage);
  });

  subscribe("reaction", (data) => {
    const participants = deps.getParticipants();
    const participant =
      participants.get(data.participantId) ??
      (deps.getLocalParticipant()?.id === data.participantId
        ? deps.getLocalParticipant()
        : undefined);
    const resolvedParticipantName =
      data.participantName && data.participantName !== "Unknown"
        ? data.participantName
        : participant?.displayName ?? "Unknown";

    deps.emit("reaction", {
      ...data,
      participantName: resolvedParticipantName,
    });
  });

  subscribe("hand.raised", (data) => {
    const participants = deps.getParticipants();
    const participant = participants.get(data.participantId);
    if (participant) {
      participant.handRaised = true;
      deps.emit("participant.updated", {
        participantId: data.participantId,
        participant,
      });
    }

    deps.emit("hand.raised", { participantId: data.participantId });
  });

  subscribe("hand.lowered", (data) => {
    const participants = deps.getParticipants();
    const participant = participants.get(data.participantId);
    if (participant) {
      participant.handRaised = false;
      deps.emit("participant.updated", {
        participantId: data.participantId,
        participant,
      });
    }

    deps.emit("hand.lowered", { participantId: data.participantId });
  });

  subscribe("recording.started", (data) => {
    deps.setCurrentRecording({ id: data.recordingId });
    deps.emit("recording.started", { recordingId: data.recordingId });
  });

  subscribe("recording.stopped", (data) => {
    const currentRecording = deps.getCurrentRecording();
    const recording: Recording = {
      id: currentRecording?.id ?? data.recordingId,
      roomId: deps.roomId,
      status: "processing",
      durationSeconds: data.duration,
    };
    deps.setCurrentRecording(null);
    deps.emit("recording.stopped", recording);
  });

  subscribe("error", (data) => {
    deps.emit("error", {
      code: data.code,
      message: data.message,
      details: (data as { details?: Record<string, unknown> }).details,
    } as ChalkError);
  });

  subscribe("room.snapshot", (snapshot) => {
    deps.emitRoomSyncReady("ws.snapshot", snapshot.participants.length);

    if (deps.hasRtkClient()) {
      if (snapshot.isRecording && snapshot.recordingId) {
        deps.setCurrentRecording({ id: snapshot.recordingId });
      }
      return;
    }

    const participants = deps.getParticipants();
    const previousIds = new Set(participants.keys());
    participants.clear();

    for (const participant of snapshot.participants) {
      const localParticipant = deps.getLocalParticipant();
      if (localParticipant && participant.id === localParticipant.id) {
        continue;
      }
      participants.set(participant.id, participant);

      if (!previousIds.has(participant.id)) {
        deps.emit("participant.joined", participant);
      }
    }

    const localParticipant = deps.getLocalParticipant();
    if (localParticipant) {
      participants.set(localParticipant.id, localParticipant);
    }

    if (snapshot.isRecording && snapshot.recordingId) {
      deps.setCurrentRecording({ id: snapshot.recordingId });
    }
  });

  subscribe("whiteboard.data", (data) => {
    deps.emit("whiteboard.update", {
      schemaVersion: data.schemaVersion,
      sceneId: data.sceneId,
      syncAll: data.syncAll,
      participantId: data.participantId,
      displayName: data.displayName,
      elements: data.elements,
      files: data.files,
      seq: data.seq,
    } as WhiteboardUpdateEvent);
  });

  subscribe("whiteboard.snapshot", (snapshot) => {
    deps.emit("whiteboard.snapshot", snapshot as WhiteboardSnapshotEvent);
  });

  subscribe("whiteboard.cursor", (data) => {
    deps.emit("whiteboard.cursor", {
      participantId: data.participantId,
      displayName: data.displayName,
      x: data.x,
      y: data.y,
    } as WhiteboardCursorEvent);
  });

  subscribe("permission.changed", (data) => {
    if (data.feature === "whiteboard") {
      deps.setWhiteboardPermission(data.participantId, data.canDraw);
      deps.emit("whiteboard.permission.changed", {
        participantId: data.participantId,
        canDraw: data.canDraw,
      });
    }
  });

  subscribe("whiteboard.opened", (data) => {
    deps.emit("whiteboard.opened", {
      participantId: data.participantId,
      displayName: data.displayName,
    });
  });

  subscribe("whiteboard.closed", (data) => {
    deps.emit("whiteboard.closed", {
      participantId: data.participantId,
    });
  });

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

interface HostAudioCommandDeps {
  getLocalParticipant: () => Participant | null;
  getRtkClient: () => {
    self: {
      audioEnabled: boolean;
      audioTrack?: MediaStreamTrack;
      enableAudio: () => Promise<void>;
      disableAudio: () => Promise<void>;
    };
  } | null;
  emitParticipantUpdated: (participantId: string, participant: Participant) => void;
  emitError: (error: ChalkError) => void;
}

export const createHostAudioCommandHandler = (deps: HostAudioCommandDeps) => {
  return async (participantId: string, enable: boolean): Promise<void> => {
    const localParticipant = deps.getLocalParticipant();
    const rtkClient = deps.getRtkClient();

    if (!localParticipant || !rtkClient) {
      return;
    }

    if (participantId !== localParticipant.id) {
      return;
    }

    const ctx = wideEvents.start("participant.moderation.audio");
    ctx.set("action", enable ? "unmute" : "mute");

    try {
      if (enable) {
        if (!rtkClient.self.audioEnabled) {
          await rtkClient.self.enableAudio();
        }
        localParticipant.audioEnabled = true;
        localParticipant.audioTrack = rtkClient.self.audioTrack ?? undefined;
      } else {
        if (rtkClient.self.audioEnabled) {
          await rtkClient.self.disableAudio();
        }
        localParticipant.audioEnabled = false;
        localParticipant.audioTrack = undefined;
      }

      deps.emitParticipantUpdated(localParticipant.id, localParticipant);
      ctx.complete("success", { enabled: localParticipant.audioEnabled });
    } catch (error) {
      ctx.complete("error", error);
      deps.emitError({
        code: "MEDIA_ERROR",
        message: enable ? "Failed to unmute microphone" : "Failed to mute microphone",
      });
    }
  };
};
