import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { ChalkError, ChatMessage, Participant, SessionConnectionState } from "../types.ts";
import type { WSClient } from "../ws-client.ts";
import type { ConferenceSessionEvents, Transcript } from "./types.ts";

interface RtkSignalingDeps {
  roomId: string;
  debug: boolean;
  getRtkClient: () => RealtimeKitClient | undefined;
  getWsClient: () => WSClient | undefined;
  getParticipants: () => Map<string, Participant>;
  getPeerIdMap: () => Map<string, string>;
  getLocalParticipant: () => Participant | null;
  getActiveSpeaker: () => Participant | null;
  setActiveSpeaker: (participant: Participant | null) => void;
  getMessages: () => ChatMessage[];
  getTranscripts: () => Transcript[];
  setConnectionState: (state: SessionConnectionState) => void;
  emitRoomSyncReady: (source: "rtk.snapshot" | "ws.snapshot", participantCount: number) => void;
  emit: <K extends keyof ConferenceSessionEvents>(event: K, data: ConferenceSessionEvents[K]) => void;
  validateTrack: (track: MediaStreamTrack | undefined | null, type: string, participantId: string) => boolean;
  logConnectionState: () => void;
}

const getRtkIds = (peerIdMap: Map<string, string>, rtkParticipant: unknown): { stableId: string; peerId: string; userId?: string } => {
  const participant = rtkParticipant as Record<string, unknown>;

  const peerId = typeof participant.id === "string" && participant.id.length > 0 ? participant.id : crypto.randomUUID();

  const directUserId =
    (typeof participant.userId === "string" && participant.userId.length > 0 ? participant.userId : undefined) ??
    (typeof participant.clientSpecificId === "string" && participant.clientSpecificId.length > 0 ? participant.clientSpecificId : undefined) ??
    (typeof participant.client_specific_id === "string" && participant.client_specific_id.length > 0 ? participant.client_specific_id : undefined) ??
    (typeof participant.customParticipantId === "string" && participant.customParticipantId.length > 0 ? participant.customParticipantId : undefined) ??
    (typeof participant.custom_participant_id === "string" && participant.custom_participant_id.length > 0 ? participant.custom_participant_id : undefined);

  const mapped = peerIdMap.get(peerId);
  const userId = directUserId ?? mapped;
  const stableId = userId ?? peerId;

  if (directUserId) {
    peerIdMap.set(peerId, directUserId);
  }

  return { stableId, peerId, userId };
};

const mapRtkParticipant = (peerIdMap: Map<string, string>, rtkParticipant: unknown): Participant => {
  const participant = rtkParticipant as Record<string, unknown>;
  const { stableId, userId } = getRtkIds(peerIdMap, rtkParticipant);
  const screenShareVideoTrack = (participant.screenShareTracks as { video?: MediaStreamTrack } | undefined)?.video ?? (participant.screenShareVideoTrack as MediaStreamTrack | undefined) ?? undefined;
  const screenShareAudioTrack = (participant.screenShareTracks as { audio?: MediaStreamTrack } | undefined)?.audio ?? (participant.screenShareAudioTrack as MediaStreamTrack | undefined) ?? undefined;

  return {
    id: stableId,
    userId,
    displayName: (participant.name as string) ?? "Unknown",
    role: "participant",
    isLocal: false,
    videoEnabled: (participant.videoEnabled as boolean) ?? false,
    audioEnabled: (participant.audioEnabled as boolean) ?? false,
    videoTrack: participant.videoTrack as MediaStreamTrack | undefined,
    audioTrack: participant.audioTrack as MediaStreamTrack | undefined,
    screenShareTrack: screenShareVideoTrack,
    screenShareAudioTrack: screenShareAudioTrack,
    isSpeaking: false,
    isScreenSharing: (participant.screenShareEnabled as boolean) ?? false,
    handRaised: false,
    connectionQuality: 100,
  };
};

const mapRtkTranscript = (data: unknown): Transcript | null => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const raw = data as Record<string, unknown>;

  const participantId = (raw.peerId as string) ?? (raw.userId as string) ?? (raw.participantId as string) ?? (raw.customParticipantId as string) ?? "";

  const speakerName = (raw.name as string) ?? (raw.participantName as string) ?? (raw.displayName as string) ?? "Unknown";

  const text = (raw.transcript as string) ?? (raw.text as string) ?? (raw.content as string) ?? "";

  if (!text) {
    return null;
  }

  const isInterim = raw.isPartialTranscript === true;

  return {
    id: (raw.id as string) ?? crypto.randomUUID(),
    participantId,
    speakerName,
    text,
    timestamp: raw.date ? new Date(raw.date as string | number) : raw.timestamp ? new Date(raw.timestamp as string | number) : new Date(),
    isInterim,
    confidence: raw.confidence as number | undefined,
  };
};

const setupTranscriptListener = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient) {
    return;
  }

  const ai = (
    rtkClient as unknown as {
      ai?: {
        transcripts?: unknown[];
        on?: (event: string, handler: (data: unknown) => void) => void;
      };
    }
  ).ai;

  if (!ai) {
    return;
  }

  const aiRecord = ai as Record<string, unknown>;
  if (typeof aiRecord.enable === "function") {
    try {
      (aiRecord.enable as () => void)();
    } catch {
      // best effort
    }
  }
  if (typeof aiRecord.start === "function") {
    try {
      (aiRecord.start as () => void)();
    } catch {
      // best effort
    }
  }
  if (typeof aiRecord.startTranscription === "function") {
    try {
      (aiRecord.startTranscription as () => void)();
    } catch {
      // best effort
    }
  }

  if (Array.isArray(ai.transcripts)) {
    for (const transcriptData of ai.transcripts) {
      const transcript = mapRtkTranscript(transcriptData);
      if (transcript) {
        deps.getTranscripts().push(transcript);
      }
    }
  }

  const eventNames = ["transcript", "transcription", "transcriptUpdate", "newTranscript", "message"];

  if (typeof ai.on === "function") {
    for (const eventName of eventNames) {
      try {
        ai.on(eventName, (data: unknown) => {
          const transcript = mapRtkTranscript(data);
          if (!transcript) {
            return;
          }

          deps.getTranscripts().push(transcript);
          deps.emit("transcript", transcript);

          if (!transcript.isInterim) {
            deps.getWsClient()?.sendTranscript(transcript);
          }
        });
      } catch {
        // unsupported event
      }
    }
  }
};

const setupActiveSpeakerListener = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient?.participants) {
    return;
  }

  const participants = rtkClient.participants as unknown as {
    on?: (event: string, handler: (speaker: unknown) => void) => void;
  };

  if (typeof participants.on !== "function") {
    return;
  }

  participants.on("activeSpeakerChanged", (speaker: unknown) => {
    if (speaker) {
      const ids = getRtkIds(deps.getPeerIdMap(), speaker);
      const participant = deps.getParticipants().get(ids.stableId) ?? null;
      if (deps.getActiveSpeaker()?.id !== participant?.id) {
        deps.setActiveSpeaker(participant);
        deps.emit("speaker.active.changed", participant);
      }
      return;
    }

    if (deps.getActiveSpeaker() !== null) {
      deps.setActiveSpeaker(null);
      deps.emit("speaker.active.changed", null);
    }
  });
};

export const setupConferenceSessionRtkSignaling = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient) {
    return;
  }

  if (deps.debug && rtkClient.participants?.joined) {
    const debugEvents = ["participantJoined", "participantLeft", "videoUpdate", "audioUpdate", "screenShareUpdate", "participantsUpdate", "participantsCleared"];

    for (const eventName of debugEvents) {
      try {
        (
          rtkClient.participants.joined as unknown as {
            on?: (event: string, handler: (data: unknown) => void) => void;
          }
        ).on?.(eventName, (_data: unknown) => {
          // debug hook
        });
      } catch {
        // best effort
      }
    }
  }

  const hasMediaStateChanged = (before: Participant, after: Participant): boolean =>
    before.displayName !== after.displayName ||
    before.videoEnabled !== after.videoEnabled ||
    before.audioEnabled !== after.audioEnabled ||
    before.isScreenSharing !== after.isScreenSharing ||
    before.videoTrack?.id !== after.videoTrack?.id ||
    before.audioTrack?.id !== after.audioTrack?.id ||
    before.screenShareTrack?.id !== after.screenShareTrack?.id ||
    before.screenShareAudioTrack?.id !== after.screenShareAudioTrack?.id;

  const mergeParticipantMediaState = (existing: Participant, incoming: Participant): Participant => ({
    ...existing,
    userId: incoming.userId ?? existing.userId,
    displayName: incoming.displayName || existing.displayName,
    videoEnabled: incoming.videoEnabled,
    audioEnabled: incoming.audioEnabled,
    videoTrack: incoming.videoTrack,
    audioTrack: incoming.audioTrack,
    isScreenSharing: incoming.isScreenSharing,
    screenShareTrack: incoming.screenShareTrack,
    screenShareAudioTrack: incoming.screenShareAudioTrack,
    isLocal: false,
  });

  const collectJoinedParticipants = (): unknown[] => {
    const participantsApi = rtkClient.participants as unknown as {
      toArray?: () => unknown[] | Iterable<unknown>;
    };
    const joined = rtkClient.participants.joined as unknown as {
      toArray?: () => unknown[] | Iterable<unknown>;
      values?: () => Iterable<unknown>;
      forEach?: (cb: (participant: unknown) => void) => void;
      [Symbol.iterator]?: () => Iterator<unknown>;
    };

    const toArray = (source: unknown): unknown[] => {
      if (!source) {
        return [];
      }
      if (Array.isArray(source)) {
        return source;
      }
      if (typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
        try {
          return Array.from(source as Iterable<unknown>);
        } catch {
          return [];
        }
      }
      return [];
    };

    if (typeof participantsApi.toArray === "function") {
      try {
        const snapshot = toArray(participantsApi.toArray());
        if (snapshot.length > 0) {
          return snapshot;
        }
      } catch {
        // fall through
      }
    }

    if (typeof joined.toArray === "function") {
      try {
        const snapshot = toArray(joined.toArray());
        if (snapshot.length > 0) {
          return snapshot;
        }
      } catch {
        // fall through
      }
    }

    if (typeof joined[Symbol.iterator] === "function") {
      try {
        const snapshot = Array.from(joined as Iterable<unknown>);
        if (snapshot.length > 0) {
          return snapshot;
        }
      } catch {
        // fall through
      }
    }

    const participants: unknown[] = [];
    if (typeof joined.values === "function") {
      try {
        for (const participant of joined.values()) {
          participants.push(participant);
        }
        if (participants.length > 0) {
          return participants;
        }
      } catch {
        // fall through
      }
    }

    if (typeof joined.forEach === "function") {
      try {
        joined.forEach((participant) => participants.push(participant));
      } catch {
        // best effort
      }
    }

    return participants;
  };

  const onParticipantsEvent = (event: string, handler: (payload?: unknown) => void): void => {
    const emitters = [
      rtkClient.participants.joined as unknown as {
        on?: (eventName: string, fn: (payload?: unknown) => void) => void;
      },
      rtkClient.participants as unknown as {
        on?: (eventName: string, fn: (payload?: unknown) => void) => void;
      },
    ];

    const attached = new Set<unknown>();
    for (const emitter of emitters) {
      if (!emitter || typeof emitter.on !== "function" || attached.has(emitter)) {
        continue;
      }
      attached.add(emitter);
      try {
        emitter.on(event, handler);
      } catch {
        // unsupported by this RTK build
      }
    }
  };

  const ensureRemoteParticipant = (rtkParticipant: unknown): Participant | null => {
    const participant = mapRtkParticipant(deps.getPeerIdMap(), rtkParticipant);
    const localParticipant = deps.getLocalParticipant();

    if (localParticipant && participant.id === localParticipant.id) {
      return null;
    }

    const participants = deps.getParticipants();
    const { peerId } = getRtkIds(deps.getPeerIdMap(), rtkParticipant);
    let existing = participants.get(participant.id);

    if (!existing && peerId !== participant.id) {
      const existingByPeerId = participants.get(peerId);
      if (existingByPeerId) {
        participants.delete(peerId);
        existing = {
          ...existingByPeerId,
          ...participant,
          id: participant.id,
          isLocal: false,
        };
        participants.set(participant.id, existing);
      }
    }

    if (!existing) {
      participants.set(participant.id, participant);
      deps.emit("participant.joined", participant);
    }

    return participant;
  };

  const reconcileJoinedParticipants = (): void => {
    const joinedParticipants = collectJoinedParticipants();
    deps.emitRoomSyncReady("rtk.snapshot", joinedParticipants.length + (deps.getLocalParticipant() ? 1 : 0));

    for (const joinedParticipant of joinedParticipants) {
      const participant = ensureRemoteParticipant(joinedParticipant);
      if (!participant) {
        continue;
      }

      const participants = deps.getParticipants();
      const existing = participants.get(participant.id);
      if (!existing) {
        continue;
      }

      const merged = mergeParticipantMediaState(existing, participant);
      if (!hasMediaStateChanged(existing, merged)) {
        continue;
      }

      participants.set(participant.id, merged);
      deps.emit("participant.updated", {
        participantId: participant.id,
        participant: merged,
      });
    }
  };

  rtkClient.self.on("roomJoined", () => {
    deps.setConnectionState("connected");

    const localParticipant = deps.getLocalParticipant();
    if (localParticipant) {
      localParticipant.videoEnabled = rtkClient.self.videoEnabled;
      localParticipant.audioEnabled = rtkClient.self.audioEnabled;
      localParticipant.videoTrack = rtkClient.self.videoTrack ?? undefined;
      localParticipant.audioTrack = rtkClient.self.audioTrack ?? undefined;

      if (localParticipant.videoEnabled) {
        deps.validateTrack(localParticipant.videoTrack, "LOCAL_VIDEO", localParticipant.id);
      }
      if (localParticipant.audioEnabled) {
        deps.validateTrack(localParticipant.audioTrack, "LOCAL_AUDIO", localParticipant.id);
      }
    }

    deps.logConnectionState();
    reconcileJoinedParticipants();
  });

  rtkClient.self.on("roomLeft", () => {
    deps.setConnectionState("disconnected");
  });

  rtkClient.self.on("videoUpdate", (data: { videoEnabled: boolean; videoTrack: MediaStreamTrack | null }) => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.videoEnabled = data.videoEnabled;
    localParticipant.videoTrack = data.videoTrack ?? undefined;

    if (data.videoEnabled) {
      const isValid = deps.validateTrack(data.videoTrack, "LOCAL_VIDEO", localParticipant.id);
      if (!isValid) {
        deps.emit("error", {
          code: "MEDIA_ERROR",
          message: "Video enabled but track unavailable or invalid",
          details: { trackState: data.videoTrack?.readyState },
        } as ChalkError);
      }
    }

    deps.emit("participant.updated", {
      participantId: localParticipant.id,
      participant: localParticipant,
    });
  });

  rtkClient.self.on("audioUpdate", (data: { audioEnabled: boolean; audioTrack: MediaStreamTrack | null }) => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.audioEnabled = data.audioEnabled;
    localParticipant.audioTrack = data.audioTrack ?? undefined;

    if (data.audioEnabled) {
      const isValid = deps.validateTrack(data.audioTrack, "LOCAL_AUDIO", localParticipant.id);
      if (!isValid) {
        deps.emit("error", {
          code: "MEDIA_ERROR",
          message: "Audio enabled but track unavailable or invalid",
          details: { trackState: data.audioTrack?.readyState },
        } as ChalkError);
      }
    }

    deps.emit("participant.updated", {
      participantId: localParticipant.id,
      participant: localParticipant,
    });
  });

  rtkClient.self.on(
    "screenShareUpdate",
    (data: {
      screenShareEnabled: boolean;
      screenShareTracks: {
        audio?: MediaStreamTrack;
        video?: MediaStreamTrack;
      };
    }) => {
      const localParticipant = deps.getLocalParticipant();
      if (!localParticipant) {
        return;
      }

      localParticipant.isScreenSharing = data.screenShareEnabled;
      localParticipant.screenShareTrack = data.screenShareTracks?.video ?? undefined;
      localParticipant.screenShareAudioTrack = data.screenShareTracks?.audio ?? undefined;

      deps.emit("participant.updated", {
        participantId: localParticipant.id,
        participant: localParticipant,
      });
    },
  );

  onParticipantsEvent("participantJoined", (rtkParticipant: unknown) => {
    ensureRemoteParticipant(rtkParticipant);
  });

  onParticipantsEvent("participantLeft", (rtkParticipant: unknown) => {
    const { stableId, peerId } = getRtkIds(deps.getPeerIdMap(), rtkParticipant);
    deps.getPeerIdMap().delete(peerId);

    const participants = deps.getParticipants();
    const deletedStable = participants.delete(stableId);
    const deletedPeer = peerId !== stableId ? participants.delete(peerId) : false;

    if (deletedStable || deletedPeer) {
      deps.emit("participant.left", stableId);
    }
  });

  onParticipantsEvent("videoUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated: Participant = {
      ...existing,
      videoEnabled: participant.videoEnabled,
      videoTrack: participant.videoTrack,
    };
    participants.set(participant.id, updated);

    if (participant.videoEnabled) {
      deps.validateTrack(participant.videoTrack, "REMOTE_VIDEO", participant.id);
    }

    deps.emit("participant.updated", {
      participantId: participant.id,
      participant: updated,
    });
  });

  onParticipantsEvent("audioUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated: Participant = {
      ...existing,
      audioEnabled: participant.audioEnabled,
      audioTrack: participant.audioTrack,
    };
    participants.set(participant.id, updated);

    if (participant.audioEnabled) {
      deps.validateTrack(participant.audioTrack, "REMOTE_AUDIO", participant.id);
    }

    deps.emit("participant.updated", {
      participantId: participant.id,
      participant: updated,
    });
  });

  onParticipantsEvent("screenShareUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated: Participant = {
      ...existing,
      isScreenSharing: participant.isScreenSharing,
      screenShareTrack: participant.screenShareTrack,
      screenShareAudioTrack: participant.screenShareAudioTrack,
    };
    participants.set(participant.id, updated);

    if (participant.isScreenSharing) {
      const isValid = deps.validateTrack(participant.screenShareTrack, "REMOTE_SCREENSHARE", participant.id);
      if (!isValid) {
        deps.emit("error", {
          code: "SCREEN_SHARE_ERROR",
          message: `Screen share track unavailable for participant ${participant.displayName}`,
          details: { participantId: participant.id },
        } as ChalkError);
      }
    }

    deps.emit("participant.updated", {
      participantId: participant.id,
      participant: updated,
    });
  });

  onParticipantsEvent("participantsUpdate", () => {
    reconcileJoinedParticipants();
  });

  onParticipantsEvent("participantsCleared", () => {
    const participants = deps.getParticipants();
    const remoteIds = Array.from(participants.values())
      .filter((participant) => !participant.isLocal)
      .map((participant) => participant.id);

    for (const participantId of remoteIds) {
      participants.delete(participantId);
      deps.emit("participant.left", participantId);
    }

    deps.getPeerIdMap().clear();

    queueMicrotask(() => reconcileJoinedParticipants());
    setTimeout(() => reconcileJoinedParticipants(), 50);
    setTimeout(() => reconcileJoinedParticipants(), 250);
  });

  if (rtkClient.chat) {
    const chat = rtkClient.chat as unknown as {
      on: (event: string, handler: (data: unknown) => void) => void;
      messages?: unknown[];
    };

    const extractMessage = (payload: unknown): ChatMessage | null => {
      const rawData = payload as Record<string, unknown>;

      if (rawData.action && rawData.action !== "add") {
        return null;
      }

      const messageData = (rawData.message as Record<string, unknown>) ?? rawData;

      const chatMessage: ChatMessage = {
        id: (messageData.id as string) ?? crypto.randomUUID(),
        senderId: (messageData.userId as string) ?? "unknown",
        senderName: (messageData.displayName as string) ?? "Unknown",
        content: (messageData.message as string) ?? (messageData.text as string) ?? (messageData.content as string) ?? "",
        timestamp: new Date((messageData.time as string) ?? (messageData.timestamp as string) ?? Date.now()),
      };

      if (typeof chatMessage.content !== "string") {
        chatMessage.content = String(chatMessage.content);
      }

      return chatMessage;
    };

    const chatEventHandler = (_eventName: string) => (payload: unknown) => {
      const chatMessage = extractMessage(payload);
      if (!chatMessage) {
        return;
      }

      const isDuplicate = deps.getMessages().some((message) => message.id === chatMessage.id || (message.senderId === chatMessage.senderId && message.content === chatMessage.content && Math.abs(new Date(message.timestamp).getTime() - new Date(chatMessage.timestamp).getTime()) < 5000));

      if (isDuplicate) {
        return;
      }

      deps.getMessages().push(chatMessage);
      deps.emit("chat.message", chatMessage);
    };

    const chatEvents = ["chatUpdate", "newMessage", "messageReceived", "message"];
    for (const eventName of chatEvents) {
      try {
        chat.on(eventName, chatEventHandler(eventName));
      } catch {
        // best effort
      }
    }
  }

  setupTranscriptListener(deps);
  setupActiveSpeakerListener(deps);
};
