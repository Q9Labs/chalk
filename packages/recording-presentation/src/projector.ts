import { RECORDING_PRESENTATION_LIMITS, type RecordingPresentationEventV1, type RecordingPresentationParticipantV1, type RecordingPresentationSnapshotV1, type RecordingPresentationTimelineV1, type RecordingSharedContentV1 } from "./types.js";
import { isRecordingPresentationTimelineV1 } from "./validator.js";

const viewFor = (sharedContent: RecordingSharedContentV1) =>
  ({
    layout: sharedContent.kind === "none" ? "grid" : "presentation",
    sidebar: "chat",
  }) as const;

const cloneSnapshot = (snapshot: RecordingPresentationSnapshotV1): RecordingPresentationSnapshotV1 => ({
  elapsedMs: snapshot.elapsedMs,
  profile: {
    ...snapshot.profile,
    viewport: { ...snapshot.profile.viewport },
    fontAssetIds: [...snapshot.profile.fontAssetIds],
    theme: { ...snapshot.profile.theme },
  },
  space: { ...snapshot.space },
  view: { ...snapshot.view },
  participants: snapshot.participants.map((participant) => ({ ...participant })),
  media: snapshot.media.map((source) => ({ ...source })),
  chat: {
    ...snapshot.chat,
    messages: snapshot.chat.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
    })),
  },
  sharedContent: { ...snapshot.sharedContent },
  reactions: snapshot.reactions.map((reaction) => ({ ...reaction })),
});

const updateParticipant = (participants: readonly RecordingPresentationParticipantV1[], participantId: string, update: (participant: RecordingPresentationParticipantV1) => RecordingPresentationParticipantV1): readonly RecordingPresentationParticipantV1[] => {
  let found = false;
  const updated = participants.map((participant) => {
    if (participant.id !== participantId) return participant;
    found = true;
    return update(participant);
  });
  if (!found) throw new TypeError(`recording presentation event references unknown participant ${participantId}`);
  return updated;
};

type EventApplier = (snapshot: RecordingPresentationSnapshotV1, event: RecordingPresentationEventV1) => RecordingPresentationSnapshotV1 | undefined;

const applyParticipantLifecycle: EventApplier = (snapshot, event) => {
  switch (event.kind) {
    case "participant_joined": {
      if (snapshot.participants.some((participant) => participant.id === event.participant.id)) throw new TypeError(`recording presentation participant ${event.participant.id} joined twice`);
      const participants = [...snapshot.participants, { ...event.participant }].sort((left, right) => left.joinOrdinal - right.joinOrdinal || left.id.localeCompare(right.id));
      return { ...snapshot, participants };
    }
    case "participant_left":
      return {
        ...snapshot,
        participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({
          ...participant,
          joined: false,
          cameraEnabled: false,
          screenShareEnabled: false,
          speaking: false,
          activeSpeaker: false,
        })),
        media: hideParticipantMedia(snapshot, event.participantId),
        sharedContent: sharedContentAfterLeave(snapshot, event.participantId),
      };
    default:
      return undefined;
  }
};

const applyParticipantIdentity: EventApplier = (snapshot, event) => {
  switch (event.kind) {
    case "participant_display_name_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, displayName: event.displayName })) };
    case "participant_hand_raised_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, handRaised: event.raised })) };
    default:
      return undefined;
  }
};

const applyParticipantDevices: EventApplier = (snapshot, event) => {
  switch (event.kind) {
    case "participant_microphone_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, microphoneMuted: event.muted })) };
    case "participant_camera_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, cameraEnabled: event.enabled })) };
    case "participant_screen_share_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, screenShareEnabled: event.enabled })) };
    default:
      return undefined;
  }
};

const applyParticipantActivity: EventApplier = (snapshot, event) => {
  switch (event.kind) {
    case "participant_speaking_changed":
      return { ...snapshot, participants: updateParticipant(snapshot.participants, event.participantId, (participant) => ({ ...participant, speaking: event.speaking })) };
    default:
      return undefined;
  }
};

const applyActiveSpeaker: EventApplier = (snapshot, event) => {
  if (event.kind !== "active_speaker_changed") return undefined;
  if (event.participantId !== null && !snapshot.participants.some((participant) => participant.id === event.participantId)) throw new TypeError(`recording presentation active speaker ${event.participantId} is unknown`);
  return {
    ...snapshot,
    participants: snapshot.participants.map((participant) => ({ ...participant, activeSpeaker: participant.id === event.participantId })),
  };
};

const applyMediaSource: EventApplier = (snapshot, event) => {
  if (event.kind !== "media_source_changed") return undefined;
  if (event.source.visible && snapshot.media.some((source) => source.sourceId !== event.source.sourceId && source.participantId === event.source.participantId && source.kind === event.source.kind && source.visible)) {
    throw new TypeError(`recording presentation has conflicting visible ${event.source.kind} sources for participant ${event.source.participantId}`);
  }
  const existing = snapshot.media.findIndex((source) => source.sourceId === event.source.sourceId);
  const media = snapshot.media.map((source) => ({ ...source }));
  if (existing === -1) media.push({ ...event.source });
  else media[existing] = { ...event.source };
  return { ...snapshot, media };
};

const applyChatMessage: EventApplier = (snapshot, event) => {
  if (event.kind !== "chat_message_added") return undefined;
  if (event.message.sequence <= snapshot.chat.headSequence) throw new TypeError("recording presentation chat sequence did not advance");
  const messages = [...snapshot.chat.messages, { ...event.message, attachments: event.message.attachments.map((attachment) => ({ ...attachment })) }].slice(-RECORDING_PRESENTATION_LIMITS.chatMessages);
  return {
    ...snapshot,
    chat: {
      retainedFloorSequence: retainedFloorSequence(messages, snapshot.chat.retainedFloorSequence),
      headSequence: event.message.sequence,
      messages,
    },
  };
};

const applyReaction: EventApplier = (snapshot, event) => {
  if (event.kind !== "reaction_added") return undefined;
  return { ...snapshot, reactions: [...snapshot.reactions.filter((reaction) => reaction.id !== event.reaction.id), { ...event.reaction }] };
};

const applySharedContent: EventApplier = (snapshot, event) => {
  if (event.kind !== "shared_content_changed") return undefined;
  if (event.sharedContent.kind === "screen_share" && !resolvesToVisibleScreenShare(snapshot, event.sharedContent)) {
    throw new TypeError("recording presentation screen share does not resolve to one visible source");
  }
  return { ...snapshot, sharedContent: { ...event.sharedContent } };
};

const EVENT_APPLIERS: readonly EventApplier[] = [applyParticipantLifecycle, applyParticipantIdentity, applyParticipantDevices, applyParticipantActivity, applyActiveSpeaker, applyMediaSource, applyChatMessage, applyReaction, applySharedContent];

const applyEvent = (snapshot: RecordingPresentationSnapshotV1, event: RecordingPresentationEventV1): RecordingPresentationSnapshotV1 => {
  for (const apply of EVENT_APPLIERS) {
    const next = apply(snapshot, event);
    if (next !== undefined) return next;
  }
  throw new TypeError(`unsupported recording presentation event ${event.kind}`);
};

const hideParticipantMedia = (snapshot: RecordingPresentationSnapshotV1, participantId: string) => snapshot.media.map((source) => (source.participantId === participantId ? { ...source, visible: false } : source));

const sharedContentAfterLeave = (snapshot: RecordingPresentationSnapshotV1, participantId: string): RecordingSharedContentV1 => {
  if (snapshot.sharedContent.kind !== "screen_share") return snapshot.sharedContent;
  return snapshot.sharedContent.participantId === participantId ? { kind: "none" } : snapshot.sharedContent;
};

const retainedFloorSequence = (messages: RecordingPresentationSnapshotV1["chat"]["messages"], fallback: number | null): number | null => {
  if (messages.length === 0) return fallback;
  return messages[0]?.sequence ?? null;
};

const resolvesToVisibleScreenShare = (snapshot: RecordingPresentationSnapshotV1, sharedContent: Extract<RecordingSharedContentV1, { readonly kind: "screen_share" }>): boolean =>
  snapshot.media.some((source) => source.sourceId === sharedContent.sourceId && source.participantId === sharedContent.participantId && source.kind === "screen_share" && source.visible);

export const projectRecordingPresentation = (timeline: RecordingPresentationTimelineV1, elapsedMs: number): RecordingPresentationSnapshotV1 => {
  if (!isRecordingPresentationTimelineV1(timeline)) throw new TypeError("invalid recording_presentation.v1 timeline");
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > timeline.clock.durationMs) throw new RangeError("recording presentation elapsedMs is outside the timeline");

  let snapshot = cloneSnapshot(timeline.initial);
  for (const event of timeline.events) {
    if (event.atMs > elapsedMs) break;
    snapshot = applyEvent(snapshot, event);
  }
  const reactions = snapshot.reactions.filter((reaction) => reaction.occurredAtMs <= elapsedMs && elapsedMs < reaction.expiresAtMs);
  const sharedContent = snapshot.sharedContent;
  return { ...snapshot, elapsedMs, view: viewFor(sharedContent), reactions };
};
