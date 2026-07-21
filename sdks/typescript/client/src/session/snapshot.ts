import type { CloudflareSFUSnapshot } from "../media";
import type { V3Capability, V3SessionSnapshot } from "../sync";
import type { ParticipantAccessSubject } from "./access";
import type { ChalkLocalMedia, ChalkMediaSource, ChalkSessionCapability, ChalkSessionConnectionPhase, ChalkSessionFailure, ChalkSessionSnapshot, ChalkSessionState } from "./types";

const SOURCES = ["microphone", "camera", "screen"] as const;

export function initialChalkSessionSnapshot(): ChalkSessionSnapshot {
  return freezeSnapshot({
    state: "idle",
    subject: null,
    connection: { sync: "idle", media: "idle" },
    admissionPolicy: null,
    participants: [],
    admissionRequests: [],
    localMedia: emptyLocalMedia(),
    remoteMedia: [],
    failure: null,
  });
}

export function projectChalkSessionSnapshot(input: {
  readonly state: ChalkSessionState;
  readonly subject: ParticipantAccessSubject | null;
  readonly sync: V3SessionSnapshot | null;
  readonly media: CloudflareSFUSnapshot | null;
  readonly localTracks: ReadonlyMap<ChalkMediaSource, MediaStreamTrack>;
  readonly localIntent: Readonly<Record<"microphone" | "camera", boolean>>;
  readonly failure: ChalkSessionFailure | null;
}): ChalkSessionSnapshot {
  const control = input.sync?.optimisticControl ?? input.sync?.control ?? null;
  return freezeSnapshot({
    state: input.state,
    subject: input.subject ? { ...input.subject } : null,
    connection: {
      sync: mapSyncPhase(input.sync?.connection.phase),
      media: mapMediaPhase(input.media?.connection.phase),
    },
    admissionPolicy: control?.admissionPolicy ?? null,
    participants:
      control?.participants.map((participant) => ({
        participantSessionId: participant.participantSessionId,
        displayName: participant.displayName,
        handRaised: participant.handRaised,
        role: participant.role,
        eligibleRoles: [...participant.eligibleRoles],
        capabilities: participant.capabilities.filter(isPublicCapability),
      })) ?? [],
    admissionRequests:
      control?.admissionRequests.map((request) => ({
        admissionRequestId: request.admissionRequestId,
        participantSessionId: request.participantSessionId,
        displayName: request.displayName,
        initialRole: request.initialRole,
        eligibleRoles: [...request.eligibleRoles],
        expiresAt: new Date(request.expiresAtMs).toISOString(),
      })) ?? [],
    localMedia: projectLocalMedia(input),
    remoteMedia:
      input.media?.remoteTracks.map((publication) => ({
        participantSessionId: publication.participantSessionId,
        source: publication.source,
        publicationId: publication.publicationId,
        track: publication.track,
      })) ?? [],
    failure: input.failure ? { ...input.failure } : null,
  });
}

function projectLocalMedia(input: Parameters<typeof projectChalkSessionSnapshot>[0]): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  const published = new Map(input.media?.localTracks.map((publication) => [publication.source, publication]));
  return Object.fromEntries(
    SOURCES.map((source) => {
      const track = input.localTracks.get(source) ?? null;
      const publication = published.get(source);
      const intended = source === "screen" ? track !== null : input.localIntent[source];
      const state = localMediaState(input.state, publication?.enabled ?? false, track !== null, intended);
      return [source, { source, state, track } satisfies ChalkLocalMedia];
    }),
  ) as Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
}

function localMediaState(state: ChalkSessionState, published: boolean, hasTrack: boolean, intended: boolean): ChalkLocalMedia["state"] {
  if (published) return "enabled";
  return intended ? intendedLocalMediaState(state, hasTrack) : unintendedLocalMediaState(state, hasTrack);
}

function intendedLocalMediaState(state: ChalkSessionState, hasTrack: boolean): ChalkLocalMedia["state"] {
  if (state === "joining") return "requesting";
  if (state === "failed") return "failed";
  return sessionMediaIsActive(state) ? activeIntentState(hasTrack) : "unavailable";
}

function unintendedLocalMediaState(state: ChalkSessionState, hasTrack: boolean): ChalkLocalMedia["state"] {
  return sessionMediaIsActive(state) || hasTrack ? "disabled" : "unavailable";
}

function sessionMediaIsActive(state: ChalkSessionState): boolean {
  return state === "live" || state === "reconnecting";
}

function activeIntentState(hasTrack: boolean): ChalkLocalMedia["state"] {
  return hasTrack ? "requesting" : "failed";
}

function emptyLocalMedia(): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  return Object.fromEntries(SOURCES.map((source) => [source, Object.freeze({ source, state: "unavailable", track: null })])) as Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
}

function mapSyncPhase(phase: V3SessionSnapshot["connection"]["phase"] | undefined): ChalkSessionConnectionPhase {
  switch (phase) {
    case "connecting":
      return "connecting";
    case "recovering":
      return "recovering";
    case "live":
      return "healthy";
    case "terminal":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "idle";
  }
}

function mapMediaPhase(phase: CloudflareSFUSnapshot["connection"]["phase"] | undefined): ChalkSessionConnectionPhase {
  switch (phase) {
    case "connecting":
      return "connecting";
    case "recovering":
      return "recovering";
    case "live":
      return "healthy";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "idle";
  }
}

function isPublicCapability(capability: V3Capability): capability is ChalkSessionCapability {
  return capability !== "manageRecording";
}

function freezeSnapshot(snapshot: ChalkSessionSnapshot): ChalkSessionSnapshot {
  const localMedia = Object.freeze(Object.fromEntries(SOURCES.map((source) => [source, Object.freeze(snapshot.localMedia[source])])) as Record<ChalkMediaSource, ChalkLocalMedia>);
  return Object.freeze({
    ...snapshot,
    subject: snapshot.subject ? Object.freeze(snapshot.subject) : null,
    connection: Object.freeze(snapshot.connection),
    participants: Object.freeze(
      snapshot.participants.map((participant) =>
        Object.freeze({
          ...participant,
          eligibleRoles: Object.freeze(participant.eligibleRoles),
          capabilities: Object.freeze(participant.capabilities),
        }),
      ),
    ),
    admissionRequests: Object.freeze(snapshot.admissionRequests.map((request) => Object.freeze({ ...request, eligibleRoles: Object.freeze(request.eligibleRoles) }))),
    localMedia,
    remoteMedia: Object.freeze(snapshot.remoteMedia.map((publication) => Object.freeze(publication))),
    failure: snapshot.failure ? Object.freeze(snapshot.failure) : null,
  });
}
