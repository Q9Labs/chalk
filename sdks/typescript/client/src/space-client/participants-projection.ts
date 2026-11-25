import type { ConnectionPorts } from "../connection";
import type { ChalkParticipantMediaState } from "../collaboration/types";
import { V1_CAPABILITIES } from "../sync/v1-types";
import type { Capability, Participant, ParticipantPresence, ParticipantsSlice, SelfSlice } from "./types";

const CAPABILITIES = new Set<Capability>(V1_CAPABILITIES);
const EMPTY_PARTICIPANTS: ParticipantsSlice = Object.freeze({ roster: Object.freeze([]), admissionQueue: Object.freeze([]), admissionPolicy: null });
export type SeatDevice = Pick<Participant, "identityId" | "deviceType"> & { readonly admissionRevision: number };

export function participantsFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, collaborationCapabilities: Readonly<Record<string, readonly string[]>>, devices: ReadonlyMap<string, SeatDevice>): ParticipantsSlice {
  const control = controlFor(snapshot);
  if (!control || control.status === "ended") return EMPTY_PARTICIPANTS;
  return Object.freeze({ roster: rosterFor(control.participants, collaborationCapabilities, mediaFor(snapshot), presenceFor(snapshot), devices), admissionQueue: admissionQueueFor(control.admissionRequests), admissionPolicy: control.admissionPolicy });
}
export function controlFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null): NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["control"]> | null {
  if (!snapshot) return null;
  if (snapshot.optimisticControl) return snapshot.optimisticControl;
  return snapshot.control;
}
function mediaFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null): ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["media"] {
  if (!snapshot) return null;
  return snapshot.media;
}
function presenceFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null): ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["presence"] {
  return snapshot?.presence ?? null;
}
function rosterFor(
  participants: NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["control"]>["participants"],
  collaborationCapabilities: Readonly<Record<string, readonly string[]>>,
  media: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["media"],
  presence: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["presence"],
  devices: ReadonlyMap<string, SeatDevice>,
): ParticipantsSlice["roster"] {
  return Object.freeze(
    participants.map((participant) =>
      Object.freeze({
        participantId: participant.participantId,
        ...(participant.identityKind === undefined ? {} : { identityKind: participant.identityKind }),
        ...(participant.description === undefined ? {} : { description: participant.description }),
        identityId: devices.get(participant.participantId)?.identityId,
        deviceType: devices.get(participant.participantId)?.deviceType,
        displayName: participant.displayName,
        role: participant.role,
        eligibleRoles: Object.freeze([...participant.eligibleRoles]),
        capabilities: capabilitiesFor(participant.capabilities, collaborationCapabilities[participant.participantId]),
        handRaised: participant.handRaised,
        media: participantMedia(participant.participantId, media),
        presence: participantPresence(participant.participantId, presence),
      }),
    ),
  );
}
function admissionQueueFor(requests: NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["control"]>["admissionRequests"]): ParticipantsSlice["admissionQueue"] {
  return Object.freeze(
    requests.map((request) =>
      Object.freeze({ requestId: request.admissionRequestId, participantId: request.participantId, displayName: request.displayName, initialRole: request.initialRole, eligibleRoles: Object.freeze([...request.eligibleRoles]), expiresAt: new Date(request.expiresAtMs).toISOString() }),
    ),
  );
}
export function selfFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, roster: ParticipantsSlice["roster"]): SelfSlice {
  const participantId = snapshot?.participantId ?? null;
  const participant = roster.find((candidate) => candidate.participantId === participantId);
  const identityId = selfIdentityFor(snapshot, participant);
  if (!participant) return emptySelf(participantId, identityId);
  const capabilities = participant.capabilities;
  const allowed = new Set(capabilities);
  return Object.freeze({ participantId, identityId, displayName: participant.displayName, role: participant.role, capabilities, handRaised: participant.handRaised, can: (capability) => allowed.has(capability) });
}
function selfIdentityFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, participant: Participant | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.connection.phase === "terminal") return undefined;
  if (snapshot.control?.status === "ended") return undefined;
  return snapshot.participantIdentityId ?? participant?.identityId;
}
function emptySelf(participantId: string | null, identityId?: string): SelfSlice {
  return Object.freeze({ participantId, identityId, displayName: null, role: null, capabilities: Object.freeze([]), handRaised: false, can: () => false });
}
function capabilitiesFor(control: readonly string[], collaboration: readonly string[] | undefined): readonly Capability[] {
  const capabilities = new Set<Capability>();
  for (const capability of [...control, ...(collaboration ?? [])]) if (CAPABILITIES.has(capability as Capability)) capabilities.add(capability as Capability);
  return Object.freeze([...capabilities]);
}
function participantMedia(participantId: string, media: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["media"]): ChalkParticipantMediaState {
  if (!media) return Object.freeze({ microphone: "unknown", camera: "unknown", screenShare: "unknown" });
  const enabled = media.items.filter((publication) => publication.participantId === participantId && publication.enabled);
  const active = new Set(enabled.map((publication) => publication.source));
  const publicationId = (source: string) => enabled.find((publication) => publication.source === source)?.publicationId ?? undefined;
  const cameraPublicationId = publicationId("camera");
  const screenSharePublicationId = publicationId("screen");
  return Object.freeze({
    microphone: active.has("microphone") ? "active" : "inactive",
    camera: active.has("camera") ? "active" : "inactive",
    screenShare: active.has("screen") ? "active" : "inactive",
    ...(cameraPublicationId ? { cameraPublicationId } : {}),
    ...(screenSharePublicationId ? { screenSharePublicationId } : {}),
  });
}
function participantPresence(participantId: string, presence: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["presence"]): ParticipantPresence {
  const item = presence?.items.find((candidate) => candidate.participantId === participantId);
  if (!item) return Object.freeze({ state: "unknown", speaking: false, activeSpeaker: false });
  return Object.freeze({ state: item.state, speaking: item.speaking, activeSpeaker: item.activeSpeaker, ...(item.connectionQuality === undefined ? {} : { connectionQuality: item.connectionQuality }) });
}
export function sameSelf(left: SelfSlice, right: SelfSlice): boolean {
  return left.participantId === right.participantId && left.identityId === right.identityId && left.displayName === right.displayName && left.role === right.role && left.handRaised === right.handRaised && sameValues(left.capabilities, right.capabilities);
}
function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
