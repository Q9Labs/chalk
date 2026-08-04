import type { ChalkChatMessage, ChalkReactionEvent, V1Capability, V1DirectedRequest, V1DirectedRequestResult, V1MediaPublication, V1MediaSource, V1Participant, V1EpisodeSnapshot } from "@q9labsai/chalk-client";

const roleCapabilities: Readonly<Record<string, readonly V1Capability[]>> = {
  owner: ["publishAudio", "publishVideo", "publishScreen", "subscribe", "sendChat", "sendReaction", "requestMediaOthers", "removeParticipant"],
  collaborator: ["publishAudio", "publishVideo", "publishScreen", "subscribe", "sendChat", "sendReaction"],
  observer: ["subscribe"],
};

export type SpaceState = {
  readonly revision: number;
  readonly participants: readonly V1Participant[];
  readonly publications: readonly V1MediaPublication[];
};

export type ServerMessage =
  | { readonly type: "state"; readonly state: SpaceState }
  | { readonly type: "ack"; readonly id: string }
  | { readonly type: "collaboration_event"; readonly event: { readonly type: "reaction"; readonly reaction: ChalkReactionEvent } | { readonly type: "chat_message"; readonly message: ChalkChatMessage } }
  | { readonly type: "collaboration_result"; readonly id: string; readonly reaction?: ChalkReactionEvent; readonly message?: ChalkChatMessage; readonly messages?: readonly ChalkChatMessage[] }
  | { readonly type: "directed_request"; readonly request: V1DirectedRequest }
  | { readonly type: "directed_request_result"; readonly id: string; readonly result: V1DirectedRequestResult }
  | { readonly type: "peers"; readonly participants: readonly string[] }
  | { readonly type: "signal"; readonly from: string; readonly description?: RTCSessionDescriptionInit; readonly candidate?: RTCIceCandidateInit | null; readonly mids?: Readonly<Record<string, V1MediaSource>> }
  | { readonly type: "force_failure" };

export function initialEpisodeSnapshot(participantId: string, generation: number): V1EpisodeSnapshot {
  return {
    connection: { phase: "idle" },
    participantId,
    participantGeneration: generation,
    control: null,
    optimisticControl: null,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
}

export function episodeSnapshot(previous: V1EpisodeSnapshot, state: SpaceState): V1EpisodeSnapshot {
  const control = {
    revision: state.revision,
    stateSchemaVersion: 1,
    stateDigest: `fixture-${state.revision}`,
    status: "active" as const,
    admissionPolicy: "open" as const,
    deadlineAtMs: Date.now() + 3_600_000,
    deadlineGeneration: 1,
    roleCapabilities,
    recording: null,
    participants: state.participants,
    admissionRequests: [],
  };
  const local = state.publications.filter((item) => item.participantId === previous.participantId);
  const remote = state.publications.filter((item) => item.participantId !== previous.participantId);
  return {
    ...previous,
    connection: { phase: "live" },
    control,
    optimisticControl: null,
    media: { projectionId: "fixture-media", sequence: state.revision, items: state.publications },
    presence: {
      projectionId: "fixture-presence",
      sequence: state.revision,
      items: state.participants.map((participant) => ({ participantId: participant.participantId, state: "connected" as const, speaking: false, activeSpeaker: false })),
    },
    mediaPlane: { local, remote },
    localMedia: {
      microphone: publicationState(local, "microphone"),
      camera: publicationState(local, "camera"),
      screen: publicationState(local, "screen"),
    },
  };
}

function publicationState(publications: readonly V1MediaPublication[], source: V1MediaSource) {
  return publications.some((item) => item.source === source && item.enabled) ? ("enabled" as const) : ("disabled" as const);
}
