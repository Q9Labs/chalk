/**
 * RoomService - Effect-based room lifecycle management
 *
 * Replaces RoomManager with Effect patterns:
 * - SubscriptionRef for observable state
 * - PubSub for typed events
 * - Semaphore for join serialization
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Context, Effect, Layer, PubSub, Ref, Stream, SubscriptionRef } from "effect";
import type { ConferenceSession } from "../../room";
import { RoomError } from "../errors";
import { LoggerService } from "../services";
import type { RoomEvent, RoomState, SessionConnectionState } from "../schemas/manager-state";
import { RoomInstanceService, setRoom } from "./room-instance";

/** Options for joining a room */
export interface JoinOptions {
  userName: string;
  role?: "host" | "participant";
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  metadata?: Record<string, unknown>;
}

/** Options for leaving a room */
export interface LeaveOptions {
  endForAll?: boolean | (() => boolean);
}

/** Initial room state */
const initialState: RoomState = {
  status: "disconnected",
  roomId: null,
  roomName: null,
  isJoining: false,
  hostId: null,
};

/**
 * RoomService interface
 */
export interface RoomServiceInterface {
  /** Get current state */
  readonly state: Effect.Effect<RoomState>;
  /** Subscribe to state via SubscriptionRef */
  readonly stateRef: SubscriptionRef.SubscriptionRef<RoomState>;
  /** Request join (actual join delegated to ChalkSession) */
  readonly requestJoin: (roomId: string, options: JoinOptions) => Effect.Effect<void, RoomError>;
  /** Mark join as complete */
  readonly joinComplete: (room: ConferenceSession) => Effect.Effect<void>;
  /** Mark join as failed */
  readonly joinFailed: (error: RoomError) => Effect.Effect<void>;
  /** Leave room */
  readonly leave: (options?: LeaveOptions) => Effect.Effect<void, RoomError>;
  /** Get underlying ConferenceSession */
  readonly getRoom: Effect.Effect<ConferenceSession | null>;
  /** Stream of room events */
  readonly events: Stream.Stream<RoomEvent>;
  /** Publish event */
  readonly publish: (event: RoomEvent) => Effect.Effect<void>;
  /** Dispose resources */
  readonly dispose: Effect.Effect<void>;
}

/**
 * RoomService Context Tag
 */
export class RoomService extends Context.Tag("@chalk/RoomService")<RoomService, RoomServiceInterface>() {}

/**
 * RoomService Live implementation
 */
export const RoomServiceLive = Layer.effect(
  RoomService,
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    const roomRef = yield* RoomInstanceService;

    // State via SubscriptionRef (auto-broadcasts changes)
    const stateRef = yield* SubscriptionRef.make<RoomState>(initialState);

    // Event bus
    const eventBus = yield* PubSub.unbounded<RoomEvent>();

    // Join semaphore (prevents concurrent joins)
    const joinSemaphore = yield* Effect.makeSemaphore(1);

    // ConferenceSession event cleanup function ref
    const cleanupRef = yield* Ref.make<(() => void) | null>(null);

    const setupRoomListeners = (room: ConferenceSession) =>
      Effect.sync(() => {
        const unsubStatus = room.on("connection.state.changed", (status) => {
          Effect.runSync(
            Effect.gen(function* () {
              yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, status: status as SessionConnectionState }));
              yield* PubSub.publish(eventBus, { _tag: "StatusChanged", status: status as SessionConnectionState });

              if (status === "connected") {
                yield* PubSub.publish(eventBus, { _tag: "Connected", roomId: room.id });
              } else if (status === "disconnected") {
                yield* PubSub.publish(eventBus, { _tag: "Disconnected", reason: "connection_lost" });
              }
            }),
          );
        });

        const unsubError = room.on("error", (error) => {
          Effect.runSync(PubSub.publish(eventBus, { _tag: "Error", error }));
        });

        return () => {
          unsubStatus();
          unsubError();
        };
      });

    return {
      state: SubscriptionRef.get(stateRef),

      stateRef,

      requestJoin: (roomId, options) =>
        joinSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(stateRef);

            if (current.isJoining) {
              return yield* Effect.fail(
                new RoomError({
                  code: "ALREADY_IN_ROOM",
                  message: "Already joining a room",
                  recoverable: false,
                }),
              );
            }

            if (current.status === "connected") {
              return yield* Effect.fail(
                new RoomError({
                  code: "ALREADY_IN_ROOM",
                  message: "Already connected to a room",
                  recoverable: false,
                }),
              );
            }

            yield* logger.info("Join requested", { roomId, userName: options.userName });
            yield* SubscriptionRef.set(stateRef, {
              ...current,
              isJoining: true,
              status: "connecting" as const,
            });
          }),
        ),

      joinComplete: (room) =>
        Effect.gen(function* () {
          yield* Effect.provideService(setRoom(room), RoomInstanceService, roomRef);

          // Setup listeners
          const cleanup = yield* setupRoomListeners(room);
          yield* Ref.set(cleanupRef, cleanup);

          yield* SubscriptionRef.set(stateRef, {
            status: "connected",
            roomId: room.id,
            roomName: room.info?.name ?? null,
            isJoining: false,
            hostId: null,
          });

          yield* logger.info("Join complete", { roomId: room.id });
          yield* PubSub.publish(eventBus, { _tag: "Connected", roomId: room.id });
        }),

      joinFailed: (error) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            isJoining: false,
            status: "failed" as const,
          }));
          yield* PubSub.publish(eventBus, { _tag: "Error", error });
        }),

      leave: (options) =>
        Effect.gen(function* () {
          const room = yield* Ref.get(roomRef);

          if (!room) {
            return yield* Effect.fail(
              new RoomError({
                code: "NOT_IN_ROOM",
                message: "Not connected to a room",
                recoverable: false,
              }),
            );
          }

          const shouldEndForAll = typeof options?.endForAll === "function" ? options.endForAll() : (options?.endForAll ?? false);

          yield* logger.info("Leaving room", { endForAll: shouldEndForAll });

          // Cleanup listeners
          const cleanup = yield* Ref.get(cleanupRef);
          if (cleanup) {
            cleanup();
            yield* Ref.set(cleanupRef, null);
          }

          yield* Effect.tryPromise({
            try: () => room.leave(),
            catch: (err) =>
              new RoomError({
                code: "NOT_IN_ROOM",
                message: err instanceof Error ? err.message : "Failed to leave room",
                recoverable: false,
              }),
          });
          yield* Ref.set(roomRef, null);

          yield* SubscriptionRef.set(stateRef, initialState);
          yield* PubSub.publish(eventBus, { _tag: "Disconnected", reason: "user_left" });
        }),

      getRoom: Ref.get(roomRef),

      events: Stream.fromPubSub(eventBus),

      publish: (event) => PubSub.publish(eventBus, event).pipe(Effect.asVoid),

      dispose: Effect.gen(function* () {
        const cleanup = yield* Ref.get(cleanupRef);
        if (cleanup) {
          cleanup();
        }
        yield* PubSub.shutdown(eventBus);
      }),
    };
  }),
);
