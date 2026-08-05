import type { CloudflareSFUSnapshot } from "../media";
import type { V1Capability, V1EpisodeSnapshot } from "../sync";
import type { AccessSubject } from "../access/grant";
import type {
  ChalkChatState,
  ChalkCollaborationCapability,
  ChalkIncomingMediaRequest,
  ChalkLocalMedia,
  ChalkMediaSource,
  ChalkParticipantMediaState,
  ChalkReactionEvent,
  ConnectionCapability,
  ConnectionConnectionPhase,
  ConnectionFailure,
  ConnectionSnapshot,
  ConnectionState,
  ChalkWhiteboardSummary,
} from "./types";

const SOURCES = ["microphone", "camera", "screen"] as const;
const SYNC_CONNECTION_PHASES = {
  idle: "idle",
  connecting: "connecting",
  recovering: "recovering",
  live: "healthy",
  terminal: "failed",
  stopped: "stopped",
} as const satisfies Readonly<Record<V1EpisodeSnapshot["connection"]["phase"], ConnectionConnectionPhase>>;
const MEDIA_CONNECTION_PHASES = {
  idle: "idle",
  connecting: "connecting",
  recovering: "recovering",
  live: "healthy",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Readonly<Record<CloudflareSFUSnapshot["connection"]["phase"], ConnectionConnectionPhase>>;
const EMPTY_CONTROL_SLICES = {
  admissionPolicy: null,
  participants: [],
  admissionRequests: [],
} satisfies Pick<ConnectionSnapshot, "admissionPolicy" | "participants" | "admissionRequests">;
const DISABLED_COLLABORATION = {
  phase: "disabled",
  version: null,
  capabilities: [],
  error: null,
} satisfies ConnectionSnapshot["collaboration"];

type ConnectionProjectionInput = {
  readonly state: ConnectionState;
  readonly subject: AccessSubject | null;
  readonly sync: V1EpisodeSnapshot | null;
  readonly media: CloudflareSFUSnapshot | null;
  readonly localTracks: ReadonlyMap<ChalkMediaSource, MediaStreamTrack>;
  readonly localIntent: Readonly<Record<"microphone" | "camera", boolean>>;
  readonly failure: ConnectionFailure | null;
  readonly collaboration?: ConnectionSnapshot["collaboration"];
  readonly participantCollaborationCapabilities?: Readonly<Record<string, readonly ChalkCollaborationCapability[]>>;
  readonly reactions?: readonly ChalkReactionEvent[];
  readonly chat?: ChalkChatState;
  readonly whiteboard?: ChalkWhiteboardSummary;
  readonly incomingMediaRequests?: readonly ChalkIncomingMediaRequest[];
};
type SnapshotControl = NonNullable<V1EpisodeSnapshot["control"]>;
type LocalPublication = CloudflareSFUSnapshot["localTracks"][number];

export function initialConnectionSnapshot(): ConnectionSnapshot {
  return freezeSnapshot({
    state: "idle",
    subject: null,
    episode: null,
    connection: { sync: "idle", media: "idle" },
    admissionPolicy: null,
    participants: [],
    admissionRequests: [],
    localMedia: emptyLocalMedia(),
    remoteMedia: [],
    failure: null,
    collaboration: { phase: "disabled", version: null, capabilities: [], error: null },
    participantCollaborationCapabilities: {},
    participantMedia: {},
    reactions: [],
    chat: emptyChat(),
    whiteboard: emptyWhiteboard(),
    incomingMediaRequests: [],
  });
}

export function projectConnectionSnapshot(input: ConnectionProjectionInput): ConnectionSnapshot {
  return freezeSnapshot(snapshotFor(input));
}

function snapshotFor(input: ConnectionProjectionInput): ConnectionSnapshot {
  const control = controlFor(input.sync);
  return {
    ...identitySlices(input.subject, control),
    ...connectionSlices(input),
    ...controlSlices(control),
    localMedia: projectLocalMedia(input),
    remoteMedia: remoteMediaFor(input.media),
    ...collaborationSlices(input),
    participantMedia: projectParticipantMedia(input.sync),
    ...contentSlices(input),
  };
}

function controlFor(sync: V1EpisodeSnapshot | null): SnapshotControl | null {
  if (!sync) return null;
  if (sync.optimisticControl) return sync.optimisticControl;
  return sync.control;
}

function identitySlices(subject: AccessSubject | null, control: SnapshotControl | null): Pick<ConnectionSnapshot, "subject" | "episode"> {
  return { subject: subject ? { ...subject } : null, episode: episodeFor(subject, control) };
}

function connectionSlices(input: ConnectionProjectionInput): Pick<ConnectionSnapshot, "state" | "connection" | "failure"> {
  return { state: input.state, connection: connectionFor(input), failure: input.failure ? { ...input.failure } : null };
}

function collaborationSlices(input: ConnectionProjectionInput): Pick<ConnectionSnapshot, "collaboration" | "participantCollaborationCapabilities"> {
  return {
    collaboration: input.collaboration ?? DISABLED_COLLABORATION,
    participantCollaborationCapabilities: input.participantCollaborationCapabilities ?? {},
  };
}

function contentSlices(input: ConnectionProjectionInput): Pick<ConnectionSnapshot, "reactions" | "chat" | "whiteboard" | "incomingMediaRequests"> {
  return { ...spaceContentSlices(input), ...liveActivitySlices(input) };
}

function spaceContentSlices(input: ConnectionProjectionInput): Pick<ConnectionSnapshot, "chat" | "whiteboard"> {
  return {
    chat: input.chat ?? emptyChat(),
    whiteboard: input.whiteboard ?? emptyWhiteboard(),
  };
}

function liveActivitySlices(input: ConnectionProjectionInput): Pick<ConnectionSnapshot, "reactions" | "incomingMediaRequests"> {
  return {
    reactions: input.reactions ?? [],
    incomingMediaRequests: input.incomingMediaRequests ?? [],
  };
}

function episodeFor(subject: AccessSubject | null, control: SnapshotControl | null): ConnectionSnapshot["episode"] {
  if (!subject) return null;
  return { id: subject.episodeId, startedAt: null, deadline: control ? new Date(control.deadlineAtMs).toISOString() : null };
}

function connectionFor(input: ConnectionProjectionInput): ConnectionSnapshot["connection"] {
  return { sync: mapSyncPhase(input.sync?.connection.phase), media: mapMediaPhase(input.media?.connection.phase) };
}

function controlSlices(control: SnapshotControl | null): Pick<ConnectionSnapshot, "admissionPolicy" | "participants" | "admissionRequests"> {
  if (!control) return EMPTY_CONTROL_SLICES;
  return {
    admissionPolicy: control.admissionPolicy,
    participants: control.participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      handRaised: participant.handRaised,
      role: participant.role,
      eligibleRoles: [...participant.eligibleRoles],
      capabilities: participant.capabilities.filter(isPublicCapability),
    })),
    admissionRequests: control.admissionRequests.map((request) => ({
      admissionRequestId: request.admissionRequestId,
      participantId: request.participantId,
      displayName: request.displayName,
      initialRole: request.initialRole,
      eligibleRoles: [...request.eligibleRoles],
      expiresAt: new Date(request.expiresAtMs).toISOString(),
    })),
  };
}

function remoteMediaFor(media: CloudflareSFUSnapshot | null): ConnectionSnapshot["remoteMedia"] {
  return media?.remoteTracks.map((publication) => ({ participantId: publication.participantId, source: publication.source, publicationId: publication.publicationId, track: publication.track })) ?? [];
}

function projectParticipantMedia(sync: V1EpisodeSnapshot | null): Readonly<Record<string, ChalkParticipantMediaState>> {
  const participants = participantsForMedia(sync);
  const active = activeMediaSources(sync);
  return Object.fromEntries(participants.map((participant) => [participant.participantId, participantMediaFor(participant.participantId, active)]));
}

function participantsForMedia(sync: V1EpisodeSnapshot | null): SnapshotControl["participants"] {
  const control = controlFor(sync);
  if (!control) return [];
  return control.participants;
}

function activeMediaSources(sync: V1EpisodeSnapshot | null): ReadonlySet<string> | null {
  if (!sync?.media) return null;
  return new Set(sync.media.items.filter((publication) => publication.enabled).map((publication) => `${publication.participantId}:${publication.source}`));
}

function participantMediaFor(participantId: string, active: ReadonlySet<string> | null): ChalkParticipantMediaState {
  if (!active) return { microphone: "unknown", camera: "unknown", screenShare: "unknown" };
  return {
    microphone: mediaStateFor(participantId, "microphone", active),
    camera: mediaStateFor(participantId, "camera", active),
    screenShare: mediaStateFor(participantId, "screen", active),
  };
}

function mediaStateFor(participantId: string, source: ChalkMediaSource, active: ReadonlySet<string>): "active" | "inactive" {
  return active.has(`${participantId}:${source}`) ? "active" : "inactive";
}

function projectLocalMedia(input: ConnectionProjectionInput): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  const published = new Map<ChalkMediaSource, LocalPublication>(input.media?.localTracks.map((publication) => [publication.source, publication]));
  return Object.fromEntries(SOURCES.map((source) => [source, projectLocalMediaSource(input, published, source)])) as Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
}

function projectLocalMediaSource(input: ConnectionProjectionInput, published: ReadonlyMap<ChalkMediaSource, LocalPublication>, source: ChalkMediaSource): ChalkLocalMedia {
  const track = trackFor(input.localTracks, source);
  const intended = localMediaIntent(input.localIntent, source, track);
  const state = localMediaState(input.state, publicationEnabled(published.get(source)), track !== null, intended);
  return { source, state, track };
}

function trackFor(tracks: ReadonlyMap<ChalkMediaSource, MediaStreamTrack>, source: ChalkMediaSource): MediaStreamTrack | null {
  return tracks.get(source) ?? null;
}

function localMediaIntent(intent: ConnectionProjectionInput["localIntent"], source: ChalkMediaSource, track: MediaStreamTrack | null): boolean {
  return source === "screen" ? track !== null : intent[source];
}

function publicationEnabled(publication: LocalPublication | undefined): boolean {
  return publication?.enabled ?? false;
}

function localMediaState(state: ConnectionState, published: boolean, hasTrack: boolean, intended: boolean): ChalkLocalMedia["state"] {
  if (published) return "enabled";
  return intended ? intendedLocalMediaState(state, hasTrack) : unintendedLocalMediaState(state, hasTrack);
}

function intendedLocalMediaState(state: ConnectionState, hasTrack: boolean): ChalkLocalMedia["state"] {
  if (state === "joining") return "requesting";
  if (state === "failed") return "failed";
  return connectionMediaIsActive(state) ? activeIntentState(hasTrack) : "unavailable";
}

function unintendedLocalMediaState(state: ConnectionState, hasTrack: boolean): ChalkLocalMedia["state"] {
  return connectionMediaIsActive(state) || hasTrack ? "disabled" : "unavailable";
}

function connectionMediaIsActive(state: ConnectionState): boolean {
  return state === "live" || state === "reconnecting";
}

function activeIntentState(hasTrack: boolean): ChalkLocalMedia["state"] {
  return hasTrack ? "requesting" : "failed";
}

function emptyLocalMedia(): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  return Object.fromEntries(SOURCES.map((source) => [source, Object.freeze({ source, state: "unavailable", track: null })])) as Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
}

function emptyChat(): ChalkChatState {
  return {
    status: "idle",
    messages: [],
    pending: [],
    hasOlder: false,
    historyTruncated: false,
    retainedFloorSequence: null,
    unreadCount: 0,
    readReceipts: [],
    localReadThroughSequence: null,
    error: null,
  };
}

function emptyWhiteboard(): ChalkWhiteboardSummary {
  return {
    status: "unsubscribed",
    sceneId: null,
    revision: null,
    capabilities: [],
    canDraw: false,
    canClear: false,
    error: null,
  };
}

function mapSyncPhase(phase: V1EpisodeSnapshot["connection"]["phase"] | undefined): ConnectionConnectionPhase {
  return phase === undefined ? "idle" : SYNC_CONNECTION_PHASES[phase];
}

function mapMediaPhase(phase: CloudflareSFUSnapshot["connection"]["phase"] | undefined): ConnectionConnectionPhase {
  return phase === undefined ? "idle" : MEDIA_CONNECTION_PHASES[phase];
}

function isPublicCapability(capability: V1Capability): capability is ConnectionCapability {
  return capability !== "manageRecording";
}

function freezeSnapshot(snapshot: ConnectionSnapshot): ConnectionSnapshot {
  return Object.freeze({
    ...snapshot,
    subject: snapshot.subject ? Object.freeze(snapshot.subject) : null,
    episode: snapshot.episode ? Object.freeze(snapshot.episode) : null,
    connection: Object.freeze(snapshot.connection),
    ...freezeControlSlices(snapshot),
    localMedia: freezeLocalMedia(snapshot.localMedia),
    remoteMedia: Object.freeze(snapshot.remoteMedia.map((publication) => Object.freeze(publication))),
    failure: snapshot.failure ? Object.freeze(snapshot.failure) : null,
    collaboration: freezeCollaboration(snapshot.collaboration),
    participantCollaborationCapabilities: freezeParticipantCapabilities(snapshot.participantCollaborationCapabilities),
    participantMedia: freezeParticipantMedia(snapshot.participantMedia),
    reactions: Object.freeze(snapshot.reactions.map((reaction) => Object.freeze(reaction))),
    chat: freezeChat(snapshot.chat),
    whiteboard: freezeWhiteboard(snapshot.whiteboard),
    incomingMediaRequests: Object.freeze(snapshot.incomingMediaRequests.map((request) => Object.freeze(request))),
  });
}

function freezeControlSlices(snapshot: ConnectionSnapshot): Pick<ConnectionSnapshot, "participants" | "admissionRequests"> {
  return {
    participants: Object.freeze(snapshot.participants.map((participant) => Object.freeze({ ...participant, eligibleRoles: Object.freeze(participant.eligibleRoles), capabilities: Object.freeze(participant.capabilities) }))),
    admissionRequests: Object.freeze(snapshot.admissionRequests.map((request) => Object.freeze({ ...request, eligibleRoles: Object.freeze(request.eligibleRoles) }))),
  };
}

function freezeLocalMedia(localMedia: ConnectionSnapshot["localMedia"]): ConnectionSnapshot["localMedia"] {
  return Object.freeze(Object.fromEntries(SOURCES.map((source) => [source, Object.freeze(localMedia[source])])) as Record<ChalkMediaSource, ChalkLocalMedia>);
}

function freezeCollaboration(collaboration: ConnectionSnapshot["collaboration"]): ConnectionSnapshot["collaboration"] {
  return Object.freeze({ ...collaboration, capabilities: Object.freeze(collaboration.capabilities), error: collaboration.error ? Object.freeze(collaboration.error) : null });
}

function freezeParticipantCapabilities(capabilities: ConnectionSnapshot["participantCollaborationCapabilities"]): ConnectionSnapshot["participantCollaborationCapabilities"] {
  return Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([participantId, values]) => [participantId, Object.freeze(values)])));
}

function freezeParticipantMedia(media: ConnectionSnapshot["participantMedia"]): ConnectionSnapshot["participantMedia"] {
  return Object.freeze(Object.fromEntries(Object.entries(media).map(([participantId, value]) => [participantId, Object.freeze(value)])));
}

function freezeChat(chat: ChalkChatState): ChalkChatState {
  return Object.freeze({
    ...chat,
    messages: Object.freeze(chat.messages.map((message) => Object.freeze({ ...message, attachments: Object.freeze(message.attachments.map((attachment) => Object.freeze(attachment))) }))),
    pending: Object.freeze(chat.pending.map((message) => Object.freeze({ ...message, attachments: Object.freeze(message.attachments.map((attachment) => Object.freeze(attachment))), error: message.error ? Object.freeze(message.error) : null }))),
    readReceipts: Object.freeze(chat.readReceipts.map((receipt) => Object.freeze(receipt))),
    error: chat.error ? Object.freeze(chat.error) : null,
  });
}

function freezeWhiteboard(whiteboard: ChalkWhiteboardSummary): ChalkWhiteboardSummary {
  return Object.freeze({ ...whiteboard, capabilities: Object.freeze(whiteboard.capabilities), error: whiteboard.error ? Object.freeze(whiteboard.error) : null });
}
