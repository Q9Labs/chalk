import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import type { ConnectionLifecycleSnapshot } from "../connection";
import type { ChatSlice, ConnectionSlice, MediaSlice, ParticipantsSlice, ReactionsSlice, SelfSlice, SpaceSnapshot, WhiteboardSlice } from "./types";

const empty = <T>(value: T): T => Object.freeze(value);
const EMPTY = empty({
  connection: empty({ status: "idle", episode: null, lastError: null }),
  self: empty({ participantId: null, displayName: null, role: null, capabilities: empty([]), handRaised: false, can: () => false }),
  participants: empty({ roster: empty([]), admissionQueue: empty([]) }),
  media: empty({
    devices: empty({ microphones: empty([]), cameras: empty([]), speakers: empty([]) }),
    selection: empty({ microphone: null, camera: null, speaker: null }),
    local: empty({ microphone: empty({ source: "microphone", state: "unavailable", track: null }), camera: empty({ source: "camera", state: "unavailable", track: null }), screen: empty({ source: "screen", state: "unavailable", track: null }) }),
    remote: empty([]),
    screenShare: empty({ source: "screen", state: "unavailable", track: null }),
    incomingRequests: empty([]),
  }),
  chat: empty({ status: "idle", messages: empty([]), pendingSends: empty([]), readReceipts: empty([]), unreadCount: 0, pagination: empty({ cursor: null, hasOlder: false, historyTruncated: false }), lastError: null }),
  reactions: empty({ active: empty([]) }),
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
    const error = snapshot.failure ? empty({ code: mapCode(snapshot.failure.code), recoverable: snapshot.failure.recoverable, message: snapshot.failure.message }) : null;
    if (current.status === snapshot.state && sameEpisode(current.episode, snapshot.episode) && sameError(current.lastError, error)) return;
    this.#replace("connection", empty({ status: snapshot.state, episode: snapshot.episode, lastError: error }));
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

function mapCode(code: string): ConnectionSlice["lastError"] extends infer T ? (T extends { readonly code: infer C } ? C : never) : never {
  return ({ invalid_access: "access.invalid", episode_ended: "episode.ended", invalid_payload: "chat.payload_invalid", permission_denied: "media.permission_denied", unsupported_environment: "environment.unsupported", rate_limited: "command.rate_limited", command_rejected: "command.rejected" }[
    code
  ] ?? "client.internal_error") as never;
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
