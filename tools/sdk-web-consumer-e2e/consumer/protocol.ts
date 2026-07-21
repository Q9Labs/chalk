import type { V3Capability, V3MediaPublication, V3MediaSource, V3Participant, V3SessionSnapshot } from "@q9labsai/chalk-client";

const capabilities: readonly V3Capability[] = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "removeParticipant"];

export type MeetingState = {
  readonly revision: number;
  readonly participants: readonly V3Participant[];
  readonly publications: readonly V3MediaPublication[];
};

export type ServerMessage =
  | { readonly type: "state"; readonly state: MeetingState }
  | { readonly type: "ack"; readonly id: string }
  | { readonly type: "peers"; readonly participants: readonly string[] }
  | { readonly type: "signal"; readonly from: string; readonly description?: RTCSessionDescriptionInit; readonly candidate?: RTCIceCandidateInit | null; readonly mids?: Readonly<Record<string, V3MediaSource>> }
  | { readonly type: "force_failure" };

export function initialSyncSnapshot(participantSessionId: string, generation: number): V3SessionSnapshot {
  return {
    connection: { phase: "idle" },
    participantSessionId,
    participantSessionGeneration: generation,
    control: null,
    optimisticControl: null,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
}

export function syncSnapshot(previous: V3SessionSnapshot, state: MeetingState): V3SessionSnapshot {
  const control = {
    revision: state.revision,
    stateSchemaVersion: 1,
    stateDigest: `fixture-${state.revision}`,
    status: "active" as const,
    admissionPolicy: "open" as const,
    hostExitPolicy: "promote_cohost" as const,
    hostParticipantSessionId: state.participants[0]?.participantSessionId ?? null,
    deadlineAtMs: Date.now() + 3_600_000,
    deadlineGeneration: 1,
    roleCapabilities: { host: capabilities, cohost: capabilities, participant: capabilities },
    recording: null,
    participants: state.participants,
    admissionRequests: [],
  };
  const local = state.publications.filter((item) => item.participantSessionId === previous.participantSessionId);
  const remote = state.publications.filter((item) => item.participantSessionId !== previous.participantSessionId);
  return {
    ...previous,
    connection: { phase: "live" },
    control,
    optimisticControl: null,
    media: { projectionId: "fixture-media", sequence: state.revision, items: state.publications },
    presence: {
      projectionId: "fixture-presence",
      sequence: state.revision,
      items: state.participants.map((participant) => ({ participantSessionId: participant.participantSessionId, state: "connected" as const, speaking: false, activeSpeaker: false })),
    },
    mediaPlane: { local, remote },
    localMedia: {
      microphone: publicationState(local, "microphone"),
      camera: publicationState(local, "camera"),
      screen: publicationState(local, "screen"),
    },
  };
}

function publicationState(publications: readonly V3MediaPublication[], source: V3MediaSource) {
  return publications.some((item) => item.source === source && item.enabled) ? ("enabled" as const) : ("disabled" as const);
}
