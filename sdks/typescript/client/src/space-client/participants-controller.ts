import { Effect } from "effect";
import type { OfflineActionsHold } from "./offline-actions";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { foreign, normalizeClientError, SpaceClientError, type ClientEffect } from "./errors";
import { SpaceStore } from "./store";
import { controlFor, participantsFor, sameSelf, selfFor, type SeatDevice } from "./participants-projection";
import type { V1ControlState, V1Participant, V1Presence, V1Projection } from "../sync/v1-types";
import type { AdmissionPolicyTarget, MediaRequestKind } from "./types";
const ADMISSION_TARGETS = new Set<string>(["open", "knock"]);
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
  readonly setAdmissionPolicy: (policy: AdmissionPolicyTarget) => ClientEffect<void>;
  readonly raiseHand: () => ClientEffect<void>;
  readonly lowerHand: () => ClientEffect<void>;
  readonly renameSelf: (displayName: string) => ClientEffect<void>;
  readonly dispose: () => void;
};
/** Scoped owner of participant subscriptions and native port commands. */
export const makeParticipantsController = (connection: ConnectionLifecycleCapability, store: SpaceStore, offline?: OfflineActionsHold): Effect.Effect<ParticipantsControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new ParticipantsControllerRuntime(connection, store, offline)),
    (controller) => Effect.sync(() => controller.dispose()),
  );
type DeviceFields = Pick<SeatDevice, "identityId" | "deviceType" | "deviceKind">;

/** What Sync just said about a seat, over what it said before for the same admission. Guests have no identity, so a device alone is enough. */
function mergeDevice(admissionRevision: number, hint: DeviceFields | undefined, known: DeviceFields | undefined): SeatDevice | undefined {
  const fields = { identityId: hint?.identityId ?? known?.identityId, deviceType: hint?.deviceType ?? known?.deviceType, deviceKind: hint?.deviceKind ?? known?.deviceKind };
  return Object.values(fields).some(Boolean) ? { admissionRevision, ...fields } : undefined;
}

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
  mute = (participantId: string): ClientEffect<void> => this.#withId(participantId, "participant ID", (sync) => sync.muteParticipant(participantId));
  stopVideo = (participantId: string): ClientEffect<void> => this.#withId(participantId, "participant ID", (sync) => sync.stopParticipantCamera(participantId));
  stopScreenShare = (participantId: string): ClientEffect<void> => this.#withId(participantId, "participant ID", (sync) => sync.stopParticipantScreenShare(participantId));
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
  remove = (participantId: string): ClientEffect<void> => this.#withId(participantId, "participant ID", (sync) => sync.removeParticipant(participantId));
  admit = (requestId: string): ClientEffect<void> => this.#withId(requestId, "admission request ID", (sync) => sync.admit(requestId));
  deny = (requestId: string): ClientEffect<void> => this.#withId(requestId, "admission request ID", (sync) => sync.deny(requestId));
  setAdmissionPolicy = (policy: AdmissionPolicyTarget): ClientEffect<void> =>
    this.#command(() => {
      if (!ADMISSION_TARGETS.has(policy)) throw invalid('Who can join must be "open" or "knock"');
      return ({ sync }) => foreign(() => sync.setAdmissionPolicy(policy));
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
  #withId<A>(id: string, label: string, run: (sync: ConnectionPorts["sync"]) => Promise<A>): ClientEffect<A> {
    return this.#command(() => {
      assertIdentifier(id, label);
      return ({ sync }) => foreign(() => run(sync));
    });
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
    const known = previous?.admissionRevision === participant.admissionRevision ? previous : undefined;
    return mergeDevice(participant.admissionRevision, this.#hintFor(participant, presence), known);
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
    this.#store.update("participants", participants);
    if (!sameSelf(this.#store.getSnapshot().self, self)) this.#store.update("self", self);
  }
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
