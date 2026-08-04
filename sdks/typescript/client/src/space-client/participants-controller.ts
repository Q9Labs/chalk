import { Context, Effect, Layer } from "effect";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../session/connection";
import type { ChalkParticipantMediaState } from "../collaboration/types";
import { normalizeClientError, SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { Capability, MediaRequestKind, ParticipantsSlice, SelfSlice } from "./types";

const CAPABILITIES = new Set<Capability>([
  "publishAudio",
  "publishVideo",
  "publishScreen",
  "subscribe",
  "raiseHand",
  "renameSelf",
  "sendChat",
  "sendReaction",
  "drawWhiteboard",
  "manageWhiteboard",
  "manageAdmission",
  "assignRoles",
  "muteOthers",
  "stopVideoOthers",
  "stopScreenOthers",
  "requestMediaOthers",
  "removeParticipant",
  "startEpisode",
  "extendEpisode",
  "endEpisode",
  "manageMembers",
  "clearSpaceContent",
]);
const EMPTY_PARTICIPANTS: ParticipantsSlice = Object.freeze({ roster: Object.freeze([]), admissionQueue: Object.freeze([]) });

type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;

export type ParticipantsControllerEffects = {
  readonly assignRole: (participantId: string, role: string) => ClientEffect<void>;
  readonly mute: (participantId: string) => ClientEffect<void>;
  readonly stopVideo: (participantId: string) => ClientEffect<void>;
  readonly stopScreenShare: (participantId: string) => ClientEffect<void>;
  readonly requestMedia: (participantId: string, kind: MediaRequestKind) => ClientEffect<{ readonly status: "delivered" | "expired" | "rate_limited" | "rejected" | "target_unavailable"; readonly requestId: string }>;
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
export const makeParticipantsController = (connection: ConnectionLifecycleCapability, store: SpaceStore): Effect.Effect<ParticipantsControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new ParticipantsControllerRuntime(connection, store)),
    (controller) => Effect.sync(() => controller.dispose()),
  );

export const makeParticipantsControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore) => Layer.effect(ParticipantsControllerService, makeParticipantsController(connection, store));

class ParticipantsControllerRuntime implements ParticipantsControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  #unsubscribePorts: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore) {
    this.#connection = connection;
    this.#store = store;
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }

  assignRole = (participantId: string, role: string): ClientEffect<void> =>
    this.#command(() => {
      assertIdentifier(participantId, "participant ID");
      assertName(role, "role");
      return ({ sync }) => foreign(() => sync.assignRole(participantId, role));
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

  requestMedia = (participantId: string, kind: MediaRequestKind): ClientEffect<{ readonly status: "delivered" | "expired" | "rate_limited" | "rejected" | "target_unavailable"; readonly requestId: string }> =>
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

  raiseHand = (): ClientEffect<void> =>
    this.#command(
      () =>
        ({ sync }) =>
          foreign(() => sync.setHandRaised(true)),
    );
  lowerHand = (): ClientEffect<void> =>
    this.#command(
      () =>
        ({ sync }) =>
          foreign(() => sync.setHandRaised(false)),
    );

  renameSelf = (displayName: string): ClientEffect<void> =>
    this.#command(() => {
      assertName(displayName, "display name");
      return ({ sync }) => foreign(() => sync.setDisplayName(displayName));
    });

  dispose(): void {
    this.#unsubscribePorts?.();
    this.#unsubscribe?.();
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
    this.#unsubscribe = null;
    if (!ports) {
      this.#publish(null, {});
      return;
    }
    this.#unsubscribe = ports.sync.subscribe((snapshot) => this.#publish(snapshot, ports.sync.getParticipantCollaborationCapabilities()));
    this.#publish(ports.sync.getSnapshot(), ports.sync.getParticipantCollaborationCapabilities());
  }

  #publish(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, collaborationCapabilities: Readonly<Record<string, readonly string[]>>): void {
    const participants = participantsFor(snapshot, collaborationCapabilities);
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
function participantsFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | null, collaborationCapabilities: Readonly<Record<string, readonly string[]>>): ParticipantsSlice {
  const control = controlFor(snapshot);
  if (!control) return EMPTY_PARTICIPANTS;
  return Object.freeze({ roster: rosterFor(control.participants, collaborationCapabilities, mediaFor(snapshot)), admissionQueue: admissionQueueFor(control.admissionRequests) });
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
function rosterFor(participants: NonNullable<ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["control"]>["participants"], collaborationCapabilities: Readonly<Record<string, readonly string[]>>, media: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>["media"]): ParticipantsSlice["roster"] {
  return Object.freeze(
    participants.map((participant) =>
      Object.freeze({
        participantId: participant.participantId,
        displayName: participant.displayName,
        role: participant.role,
        eligibleRoles: Object.freeze([...participant.eligibleRoles]),
        capabilities: capabilitiesFor(participant.capabilities, collaborationCapabilities[participant.participantId]),
        handRaised: participant.handRaised,
        media: participantMedia(participant.participantId, media),
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
  if (!participant) return emptySelf(participantId);
  const capabilities = participant.capabilities;
  const allowed = new Set(capabilities);
  return Object.freeze({ participantId, displayName: participant.displayName, role: participant.role, capabilities, handRaised: participant.handRaised, can: (capability) => allowed.has(capability) });
}
function emptySelf(participantId: string | null): SelfSlice {
  return Object.freeze({ participantId, displayName: null, role: null, capabilities: Object.freeze([]), handRaised: false, can: () => false });
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
function sameParticipants(left: ParticipantsSlice, right: ParticipantsSlice): boolean {
  return (
    sameArray(
      left.roster,
      right.roster,
      (current, next) =>
        current.participantId === next.participantId &&
        current.displayName === next.displayName &&
        current.role === next.role &&
        current.handRaised === next.handRaised &&
        sameValues(current.eligibleRoles, next.eligibleRoles) &&
        sameValues(current.capabilities, next.capabilities) &&
        current.media.microphone === next.media.microphone &&
        current.media.camera === next.media.camera &&
        current.media.screenShare === next.media.screenShare,
    ) &&
    sameArray(
      left.admissionQueue,
      right.admissionQueue,
      (current, next) => current.requestId === next.requestId && current.participantId === next.participantId && current.displayName === next.displayName && current.initialRole === next.initialRole && current.expiresAt === next.expiresAt && sameValues(current.eligibleRoles, next.eligibleRoles),
    )
  );
}
function sameSelf(left: SelfSlice, right: SelfSlice): boolean {
  return left.participantId === right.participantId && left.displayName === right.displayName && left.role === right.role && left.handRaised === right.handRaised && sameValues(left.capabilities, right.capabilities);
}
function sameArray<T>(left: readonly T[], right: readonly T[], equal: (current: T, next: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => equal(value, right[index]!));
}
function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
