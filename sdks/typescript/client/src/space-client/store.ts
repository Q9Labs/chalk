import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { connectionErrorCode } from "./errors";
import type { ConnectionLifecycleSnapshot } from "../connection";
import type { ChatSlice, ConnectionSlice, MediaSlice, ParticipantsSlice, ReactionsSlice, RecordingSlice, OfflineSlice, SelfSlice, SpaceSnapshot, WhiteboardSlice } from "./types";

const INTERRUPTED_CONNECTION_PHASES = new Set<ConnectionLifecycleSnapshot["connection"]["sync"]>(["unresponsive", "connecting", "recovering"]);

const empty = <T>(value: T): T => Object.freeze(value);
const EMPTY = empty({
  connection: empty({ status: "idle", episode: null, lastError: null, episodeEnded: false, removedByHost: false }),
  self: empty({ participantId: null, displayName: null, role: null, capabilities: empty([]), handRaised: false, can: () => false }),
  participants: empty({ roster: empty([]), admissionQueue: empty([]) }),
  media: empty({
    devices: empty({ microphones: empty([]), cameras: empty([]), speakers: empty([]) }),
    selection: empty({ microphone: null, camera: null, speaker: null }),
    local: empty({ microphone: empty({ source: "microphone", state: "unavailable", track: null }), camera: empty({ source: "camera", state: "unavailable", track: null }), screen: empty({ source: "screen", state: "unavailable", track: null }) }),
    remote: empty([]),
    screenShare: empty({ source: "screen", state: "unavailable", track: null, hasAudio: false }),
    incomingRequests: empty([]),
  }),
  chat: empty({ status: "idle", messages: empty([]), pendingSends: empty([]), readReceipts: empty([]), unreadCount: 0, pagination: empty({ cursor: null, hasOlder: false, historyTruncated: false }), lastError: null }),
  reactions: empty({ active: empty([]) }),
  recording: empty({ current: null }),
  offline: empty({ pending: empty([]), decisionNeeded: false, policy: "send" }),
  whiteboard: empty({ open: false, engine: empty({ status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null }) }),
}) satisfies SpaceSnapshot;

export class SpaceStore {
  readonly #listeners = new Set<() => void>();
  readonly #ref: SubscriptionRef.SubscriptionRef<SpaceSnapshot>;

  constructor(ref?: SubscriptionRef.SubscriptionRef<SpaceSnapshot>) {
    this.#ref = ref ?? Effect.runSync(SubscriptionRef.make<SpaceSnapshot>(EMPTY));
  }

  /** Builds the store inside a Layer without executing an Effect at module load. */
  static make(): Effect.Effect<SpaceStore> {
    return SubscriptionRef.make<SpaceSnapshot>(EMPTY).pipe(Effect.map((ref) => new SpaceStore(ref)));
  }

  getSnapshot = (): SpaceSnapshot => SubscriptionRef.getUnsafe(this.#ref);
  /** Every snapshot change, including the current value, for Effect consumers. */
  get changes(): Stream.Stream<SpaceSnapshot> {
    return SubscriptionRef.changes(this.#ref);
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  updateConnection(snapshot: ConnectionLifecycleSnapshot): void {
    const current = this.getSnapshot().connection;
    const error = connectionError(snapshot.failure);
    const next: ConnectionSlice = {
      status: connectionStatus(snapshot),
      syncHealth: snapshot.connection.syncHealth,
      episode: snapshot.episode,
      lastError: sameError(current.lastError, error) ? current.lastError : error,
      episodeEnded: snapshot.episodeEnded ?? false,
      removedByHost: snapshot.removedByHost ?? false,
    };
    if (sameConnection(current, next)) return;
    this.#replace("connection", empty(next));
  }
  updateSelf(value: SelfSlice): void {
    this.#replace("self", value);
  }
  updateParticipants(value: ParticipantsSlice): void {
    this.#replace("participants", value);
  }
  updateMedia(value: MediaSlice): void {
    this.#replace("media", value);
  }
  updateChat(value: ChatSlice): void {
    this.#replace("chat", value);
  }
  updateReactions(value: ReactionsSlice): void {
    this.#replace("reactions", value);
  }
  updateRecording(value: RecordingSlice): void {
    this.#replace("recording", value);
  }
  updateOffline(value: OfflineSlice): void {
    this.#replace("offline", value);
  }
  updateWhiteboard(value: WhiteboardSlice): void {
    this.#replace("whiteboard", value);
  }
  select(kind: keyof MediaSlice["selection"], deviceId: string): void {
    const current = this.getSnapshot();
    this.updateMedia(empty({ ...current.media, selection: empty({ ...current.media.selection, [kind]: deviceId }) }));
  }
  #replace<TSlice extends keyof SpaceSnapshot>(key: TSlice, value: SpaceSnapshot[TSlice]): void {
    const current = this.getSnapshot();
    if (current[key] === value) return;
    const next = empty({ ...current, [key]: value });
    Effect.runSync(SubscriptionRef.set(this.#ref, next));
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* state observers cannot interrupt the connection */
      }
    }
  }
}

/** Store capability shared by the Effect-native client composition. */
export class SpaceStoreService extends Context.Service<SpaceStoreService, SpaceStore>()("@chalk/client/SpaceStore") {}

export const makeSpaceStoreLayer = Layer.effect(SpaceStoreService, SpaceStore.make());
export const makeFakeSpaceStoreLayer = (store = new SpaceStore()) => Layer.succeed(SpaceStoreService, store);

function connectionError(failure: ConnectionLifecycleSnapshot["failure"]): ConnectionSlice["lastError"] {
  return failure ? empty({ code: connectionErrorCode(failure.code, failure.action), recoverable: failure.recoverable, message: failure.message, ...(failure.sync ? { sync: failure.sync } : {}) }) : null;
}

function connectionStatus(snapshot: ConnectionLifecycleSnapshot): ConnectionSlice["status"] {
  const interrupted = INTERRUPTED_CONNECTION_PHASES.has(snapshot.connection.sync) || INTERRUPTED_CONNECTION_PHASES.has(snapshot.connection.media);
  return snapshot.state === "live" && interrupted ? "reconnecting" : snapshot.state;
}

function sameConnection(left: ConnectionSlice, right: ConnectionSlice): boolean {
  return left.status === right.status && left.syncHealth === right.syncHealth && sameEpisode(left.episode, right.episode) && left.lastError === right.lastError && left.episodeEnded === right.episodeEnded && left.removedByHost === right.removedByHost;
}

function sameEpisode(left: ConnectionSlice["episode"], right: ConnectionSlice["episode"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id && left.startedAt === right.startedAt && left.deadline === right.deadline;
}
function sameError(left: ConnectionSlice["lastError"], right: ConnectionSlice["lastError"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.code === right.code && left.recoverable === right.recoverable && left.message === right.message;
}
