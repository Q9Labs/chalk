import { Context, Effect, Layer } from "effect";
import type { OfflineActionsHold } from "./offline-actions";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { ChalkParticipantMediaState } from "../collaboration/types";
import { normalizeClientError, SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { V1ControlState, V1Participant, V1Presence, V1Projection } from "../sync/v1-types";
import { V1_CAPABILITIES } from "../sync/v1-types";
import type { Capability, MediaRequestKind, Participant, ParticipantPresence, ParticipantsSlice, SelfSlice } from "./types";
export const CAPABILITIES = new Set<Capability>(V1_CAPABILITIES);
const EMPTY_PARTICIPANTS: ParticipantsSlice = Object.freeze({ roster: Object.freeze([]), admissionQueue: Object.freeze([]) });
type SeatDevice = Pick<Participant, "identityId" | "deviceType"> & { readonly admissionRevision: number };
type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
export type ParticipantsControllerEffects = {
  readonly assignRole: (participantId: string, roleName: string) => ClientEffect<void>;
  readonly mute: (participantId: string) => ClientEffect<void>;
  readonly stopVideo: (participantId: string) => ClientEffect<void>;
  readonly stopScreenShare: (participantId: string) => ClientEffect<void>;
  readonly requestMedia: (
    participantId: string,
    kind: MediaRequestKind,
  ) => ClientEffect<{
    readonly status: "delivered" | "expired" | "rate_limited" | "rejected" | "target_unavailable";
    readonly requestId: string;
  }>;
  readonly remove: (participantId: string) => ClientEffect<void>;
  readonly admit: (requestId: string) => ClientEffect<void>;
  readonly deny: (requestId: string) => ClientEffect<void>;
  readonly raiseHand: () => ClientEffect<void>;
  readonly lowerHand: () => ClientEffect<void>;
  readonly renameSelf: (displayName: string) => ClientEffect<void>;
  readonly dispose: () => void;
};
export class ParticipantsControllerService extends Context.Service<ParticipantsControllerService, ParticipantsControllerEffects>()("@chalk/client/ParticipantsController") {}
/** Scoped owner of participant subscriptions and native port commands. */
export const makeParticipantsController = (connection: ConnectionLifecycleCapability, store: SpaceStore, offline?: OfflineActionsHold): Effect.Effect<ParticipantsControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new ParticipantsControllerRuntime(connection, store, offline)),
    (controller) => Effect.sync(() => controller.dispose()),
  );
export const makeParticipantsControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore) => Layer.effect(ParticipantsControllerService, makeParticipantsController(connection, store));
class ParticipantsControllerRuntime implements ParticipantsControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #offline: OfflineActionsHold | undefined;
  #unsubscribePorts: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeMedia: (() => void) | null = null;
  #deviceScope: string | null = null;
  // Retain verified seats while the local Sync replica is recovering, and for older servers
  // whose negotiated hints disappear with sockets. New servers send every admitted seat.
  #devices = new Map<string, SeatDevice>();
  #presenceCursor: string | null = null;
  readonly #invalidatedDevices = new Set<string>();
  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, offline?: OfflineActionsHold) {
    this.#offline = offline;
    this.#connection = connection;
    this.#store = store;
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }
  assignRole = (participantId: string, roleName: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      assertName(roleName, "role");
      return ({ sync }) => foreign(() => sync.assignRole(participantId, roleName));
    });
  mute = (participantId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      return ({ sync }) => foreign(() => sync.muteParticipant(participantId));
    });
  stopVideo = (participantId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      return ({ sync }) => foreign(() => sync.stopParticipantCamera(participantId));
    });
  stopScreenShare = (participantId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      return ({ sync }) => foreign(() => sync.stopParticipantScreenShare(participantId));
    });
  requestMedia = (
    participantId: string,
    kind: MediaRequestKind,
  ): ClientEffect<{
    readonly status: "delivered" | "expired" | "rate_limited" | "rejected" | "target_unavailable";
    readonly requestId: string;
  }> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      if (kind !== "microphone" && kind !== "camera") throw invalid("Media requests must target a microphone or camera");
      return ({ sync }) => (kind === "microphone" ? foreign(() => sync.requestUnmute(participantId)) : foreign(() => sync.requestStartCamera(participantId))).pipe(Effect.map(directed));
    });
  remove = (participantId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      return ({ sync }) => foreign(() => sync.removeParticipant(participantId));
    });
  admit = (requestId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(requestId, "admission request ID");
      return ({ sync }) => foreign(() => sync.admit(requestId));
    });
  deny = (requestId: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(requestId, "admission request ID");
      return ({ sync }) => foreign(() => sync.deny(requestId));
    });
  raiseHand = (): ClientEffect<void> => this.#setHandRaised(true);
  lowerHand = (): ClientEffect<void> => this.#setHandRaised(false);
  #setHandRaised(raised: boolean): ClientEffect<void> {
    const send = () =>
      this.#command(
        () =>
          ({ sync }) =>
            foreign(() => sync.setHandRaised(raised)),
      );
    return this.#offline?.hold({ kind: raised ? "hand_raise" : "hand_lower" }, send) ?? send();
  }
  renameSelf = (displayName: string): ClientEffect<void> =>
    this.#command(() => {
      assertName(displayName, "display name");
      return ({ sync }) => foreign(() => sync.setDisplayName(displayName));
    });
  dispose(): void {
    this.#devices.clear();
    this.#invalidatedDevices.clear();
    this.#unsubscribePorts?.();
    this.#unsubscribe?.();
    this.#unsubscribeMedia?.();
    this.#unsubscribeMedia = null;
    this.#unsubscribePorts = null;
    this.#unsubscribe = null;
  }
  #command<A>(operation: () => (ports: ConnectionPorts) => Effect.Effect<A, unknown>): ClientEffect<A> {
    return Effect.try({ try: operation, catch: normalizeClientError }).pipe(
      Effect.flatMap((run) => this.#connection.runCommand(run)),
      Effect.mapError(normalizeClientError),
    );
  }
  #bind(ports: ConnectionPorts | null): void {
    this.#unsubscribe?.();
    this.#unsubscribeMedia?.();
    this.#unsubscribe = null;
    this.#unsubscribeMedia = null;
    if (!ports) {
      if (["idle", "leaving", "left", "failed"].includes(this.#connection.getSnapshot().state)) {
        this.#devices.clear();
        this.#invalidatedDevices.clear();
      }
      this.#publish(null, {});
      return;
    }
    const publish = () => this.#publish(ports.sync.getSnapshot(), ports.sync.getParticipantCollaborationCapabilities(), ports.media.getSnapshot());
    this.#unsubscribe = ports.sync.subscribe(publish);
    this.#unsubscribeMedia = ports.media.subscribe(publish);
    publish();
  }
  #syncDeviceScope(): void {
    const subject = this.#connection.getSnapshot().subject;
    const scope = subject ? JSON.stringify([subject.tenantId, subject.spaceId, subject.episodeId, subject.participantId, subject.participantGeneration]) : null;
    if (scope !== this.#deviceScope) {
      this.#devices.clear();
      this.#invalidatedDevices.clear();
    }
    this.#deviceScope = scope;
  }
  #rememberDevices(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null): void {
    this.#syncDeviceScope();
    const control = snapshot?.control;
    if (!control) return;
    this.#pruneDevices(control, snapshot.presence);
    const retained = new Map<string, SeatDevice>();
    if (control.status !== "ended") {
      for (const participant of control.participants) {
        const device = this.#deviceFor(participant, snapshot.presence?.items ?? []);
        if (device) retained.set(participant.participantId, device);
      }
    }
    this.#devices = retained;
  }
  #pruneDevices(control: V1ControlState, presence: V1Projection<V1Presence> | null): void {
    const cursor = presence ? JSON.stringify([presence.projectionId, presence.sequence]) : null;
    if (cursor !== this.#presenceCursor) this.#invalidatedDevices.clear();
    this.#presenceCursor = cursor;
    // A new admission cannot inherit a hint still buffered from the old seat.
    for (const [id, device] of this.#devices) {
      if (!control.participants.some((participant) => participant.participantId === id && participant.admissionRevision === device.admissionRevision)) this.#invalidatedDevices.add(id);
    }
  }
  #deviceFor(participant: V1Participant, presence: readonly V1Presence[]): SeatDevice | undefined {
    const previous = this.#devices.get(participant.participantId);
    const known: Pick<SeatDevice, "identityId" | "deviceType"> = previous && previous.admissionRevision === participant.admissionRevision ? previous : {};
    const hint: Pick<SeatDevice, "identityId" | "deviceType"> = this.#hintFor(participant, presence) ?? {};
    const identityId = hint.identityId ?? known.identityId;
    return identityId ? { admissionRevision: participant.admissionRevision, identityId, deviceType: hint.deviceType ?? known.deviceType } : undefined;
  }
  #hintFor(participant: V1Participant, presence: readonly V1Presence[]): V1Presence | undefined {
    return presence.find((item) => {
      if (item.participantId !== participant.participantId) return false;
      if (item.admissionRevision !== undefined) return item.admissionRevision === participant.admissionRevision;
      return !this.#invalidatedDevices.has(participant.participantId);
    });
  }
  #publish(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, collaborationCapabilities: Readonly<Record<string, readonly string[]>>, media?: ReturnType<ConnectionPorts["media"]["getSnapshot"]>): void {
    this.#rememberDevices(snapshot);
    // A missing replica during digest recovery is not a durable participant leave.
    if (snapshot && !controlFor(snapshot)) return;
    const audioParticipants = new Set(media?.remoteTracks.filter((track) => track.source === "screen_audio" && track.track.readyState === "live").map((track) => track.participantId));
    if (snapshot?.participantId && media?.localTracks.some((track) => track.source === "screen_audio" && track.enabled && track.track.readyState === "live")) audioParticipants.add(snapshot.participantId);
    const projected = participantsFor(snapshot, collaborationCapabilities, this.#devices);
    const participants = Object.freeze({
      ...projected,
      roster: Object.freeze(projected.roster.map((participant) => Object.freeze({ ...participant, media: Object.freeze({ ...participant.media, screenShareHasAudio: participant.media.screenShare === "active" && audioParticipants.has(participant.participantId) }) }))),
    });
    const self = selfFor(snapshot, participants.roster);
    const current = this.#store.getSnapshot();
    if (!sameParticipants(current.participants, participants)) this.#store.updateParticipants(participants);
    if (!sameSelf(current.self, self)) this.#store.updateSelf(self);
  }
}
function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(`A non-empty ${label} is required`);
}
function assertName(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw invalid(`A trimmed ${label} is required`);
}
function invalid(message: string): SpaceClientError {
  return new SpaceClientError({ code: "participant.invalid", recoverable: false, message });
}
function directed(result: { readonly request_id: string; readonly result: "delivered" | "expired" | "rate_limited" | "rejected" | "target_unavailable" }) {
  return Object.freeze({ status: result.result, requestId: result.request_id });
}
function participantsFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, collaborationCapabilities: Readonly<Record<string, readonly string[]>>, devices: ReadonlyMap<string, SeatDevice>): ParticipantsSlice {
  const control = controlFor(snapshot);
  if (!control || control.status === "ended") return EMPTY_PARTICIPANTS;
  return Object.freeze({ roster: rosterFor(control.participants, collaborationCapabilities, mediaFor(snapshot), presenceFor(snapshot), devices), admissionQueue: admissionQueueFor(control.admissionRequests) });
}
function controlFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null): NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["control"]> | null {
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
function selfFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, roster: ParticipantsSlice["roster"]): SelfSlice {
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
  const active = new Set(media.items.filter((publication) => publication.participantId === participantId && publication.enabled).map((publication) => publication.source));
  return Object.freeze({ microphone: active.has("microphone") ? "active" : "inactive", camera: active.has("camera") ? "active" : "inactive", screenShare: active.has("screen") ? "active" : "inactive" });
}
function participantPresence(participantId: string, presence: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["presence"]): ParticipantPresence {
  const item = presence?.items.find((candidate) => candidate.participantId === participantId);
  if (!item) return Object.freeze({ state: "unknown", speaking: false, activeSpeaker: false });
  return Object.freeze({ state: item.state, speaking: item.speaking, activeSpeaker: item.activeSpeaker });
}
function sameParticipants(left: ParticipantsSlice, right: ParticipantsSlice): boolean {
  return (
    sameArray(left.roster, right.roster, sameParticipant) &&
    sameArray(
      left.admissionQueue,
      right.admissionQueue,
      (current, next) => current.requestId === next.requestId && current.participantId === next.participantId && current.displayName === next.displayName && current.initialRole === next.initialRole && current.expiresAt === next.expiresAt && sameValues(current.eligibleRoles, next.eligibleRoles),
    )
  );
}
function sameParticipant(left: Participant, right: Participant): boolean {
  return sameParticipantProfile(left, right) && sameParticipantMedia(left, right) && sameParticipantPresence(left, right);
}
function sameParticipantProfile(left: Participant, right: Participant): boolean {
  return left.participantId === right.participantId && left.displayName === right.displayName && left.role === right.role && left.handRaised === right.handRaised && sameValues(left.eligibleRoles, right.eligibleRoles) && sameValues(left.capabilities, right.capabilities);
}
function sameParticipantMedia(left: Participant, right: Participant): boolean {
  return left.media.microphone === right.media.microphone && left.media.camera === right.media.camera && left.media.screenShare === right.media.screenShare && left.media.screenShareHasAudio === right.media.screenShareHasAudio;
}
function sameParticipantPresence(left: Participant, right: Participant): boolean {
  return left.identityId === right.identityId && left.deviceType === right.deviceType && left.presence.state === right.presence.state && left.presence.speaking === right.presence.speaking && left.presence.activeSpeaker === right.presence.activeSpeaker;
}
function sameSelf(left: SelfSlice, right: SelfSlice): boolean {
  return left.participantId === right.participantId && left.identityId === right.identityId && left.displayName === right.displayName && left.role === right.role && left.handRaised === right.handRaised && sameValues(left.capabilities, right.capabilities);
}
function sameArray<T>(left: readonly T[], right: readonly T[], equal: (current: T, next: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => equal(value, right[index]!));
}
function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
