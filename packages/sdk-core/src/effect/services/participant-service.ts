/**
 * ParticipantService - Effect-based participant management
 *
 * Replaces ParticipantManager with Effect patterns:
 * - SubscriptionRef for observable state
 * - PubSub for typed events
 * - Automatic sync from Room events
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Context, Effect, Layer, PubSub, Ref, Stream, SubscriptionRef } from "effect";
import type { Room } from "../../room";
import type { Participant } from "../../types";
import { LoggerService } from "../services";
import type { ParticipantEvent, ParticipantState, ParticipantData } from "../schemas/manager-state";
import { RoomInstanceService } from "./room-instance";

/** Initial participant state */
const initialState: ParticipantState = {
  participants: [],
  activeSpeaker: null,
  localParticipant: null,
  count: 0,
};

/**
 * ParticipantService interface
 */
export interface ParticipantServiceInterface {
  /** Get current state */
  readonly state: Effect.Effect<ParticipantState>;
  /** Subscribe to state via SubscriptionRef */
  readonly stateRef: SubscriptionRef.SubscriptionRef<ParticipantState>;
  /** Get participant by ID */
  readonly getParticipant: (id: string) => Effect.Effect<ParticipantData | undefined>;
  /** Get remote participants */
  readonly remoteParticipants: Effect.Effect<readonly ParticipantData[]>;
  /** Attach to room and setup listeners */
  readonly attachRoom: (room: Room) => Effect.Effect<void>;
  /** Detach from room */
  readonly detach: Effect.Effect<void>;
  /** Stream of participant events */
  readonly events: Stream.Stream<ParticipantEvent>;
  /** Dispose resources */
  readonly dispose: Effect.Effect<void>;
}

/**
 * ParticipantService Context Tag
 */
export class ParticipantService extends Context.Tag("@chalk/ParticipantService")<
  ParticipantService,
  ParticipantServiceInterface
>() {}

/** Normalize participant to match schema */
const normalizeParticipant = (p: Participant): ParticipantData => ({
  id: p.id,
  displayName: p.displayName,
  role: p.role ?? "participant",
  isLocal: p.isLocal,
  videoEnabled: p.videoEnabled ?? false,
  audioEnabled: p.audioEnabled ?? false,
  isScreenSharing: p.isScreenSharing ?? false,
  isSpeaking: p.isSpeaking ?? false,
  handRaised: p.handRaised ?? false,
  connectionQuality: p.connectionQuality ?? 100,
  videoTrack: p.videoTrack ?? undefined,
  audioTrack: p.audioTrack ?? undefined,
  screenShareTrack: p.screenShareTrack ?? undefined,
  screenShareAudioTrack: p.screenShareAudioTrack ?? undefined,
  joinedAt: p.joinedAt ?? undefined,
  metadata: p.metadata ?? undefined,
});

/**
 * ParticipantService Live implementation
 */
export const ParticipantServiceLive = Layer.effect(
  ParticipantService,
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    yield* RoomInstanceService; // Ensure dependency

    // State via SubscriptionRef
    const stateRef = yield* SubscriptionRef.make<ParticipantState>(initialState);

    // Participant map for fast lookups
    const participantMapRef = yield* Ref.make<Map<string, ParticipantData>>(new Map());

    // Event bus
    const eventBus = yield* PubSub.unbounded<ParticipantEvent>();

    // Cleanup function ref
    const cleanupRef = yield* Ref.make<(() => void) | null>(null);

    const updateState = Effect.gen(function* () {
      const participantMap = yield* Ref.get(participantMapRef);
      const participants = Array.from(participantMap.values());
      const localParticipant = participants.find((p) => p.isLocal) ?? null;
      const currentState = yield* SubscriptionRef.get(stateRef);

      yield* SubscriptionRef.set(stateRef, {
        participants,
        localParticipant,
        activeSpeaker: currentState.activeSpeaker,
        count: participants.length,
      });
    });

    const syncFromRoom = (room: Room) =>
      Effect.gen(function* () {
        const participantMap = new Map<string, ParticipantData>();

        // Add all participants from room
        for (const [id, participant] of room.participants) {
          participantMap.set(id, normalizeParticipant(participant));
        }

        // Add local participant
        if (room.localParticipant) {
          const local = normalizeParticipant(room.localParticipant);
          participantMap.set(local.id, local);
        }

        yield* Ref.set(participantMapRef, participantMap);
        yield* updateState;
      });

    const setupRoomListeners = (room: Room) =>
      Effect.sync(() => {
        const unsubJoined = room.on("participant-joined", (participant) => {
          const normalized = normalizeParticipant(participant);
          Effect.runSync(
            Effect.gen(function* () {
              const map = yield* Ref.get(participantMapRef);
              map.set(normalized.id, normalized);
              yield* Ref.set(participantMapRef, map);
              yield* updateState;
              yield* logger.info("Participant joined", {
                participantId: normalized.id,
                displayName: normalized.displayName,
              });
              yield* PubSub.publish(eventBus, { _tag: "Joined", participant: normalized });
            })
          );
        });

        const unsubLeft = room.on("participant-left", (participantId) => {
          Effect.runSync(
            Effect.gen(function* () {
              const map = yield* Ref.get(participantMapRef);
              const p = map.get(participantId);
              map.delete(participantId);
              yield* Ref.set(participantMapRef, map);
              yield* updateState;
              yield* logger.info("Participant left", {
                participantId,
                displayName: p?.displayName,
              });
              yield* PubSub.publish(eventBus, { _tag: "Left", participantId });
            })
          );
        });

        const unsubUpdated = room.on("participant-updated", ({ participantId, participant }) => {
          const normalized = normalizeParticipant(participant);
          Effect.runSync(
            Effect.gen(function* () {
              const map = yield* Ref.get(participantMapRef);
              map.set(participantId, normalized);
              yield* Ref.set(participantMapRef, map);
              yield* updateState;
              yield* logger.debug("Participant updated", { participantId });
              yield* PubSub.publish(eventBus, {
                _tag: "Updated",
                participantId,
                participant: normalized,
              });
            })
          );
        });

        const unsubActiveSpeaker = room.on("active-speaker-changed", (speaker) => {
          const normalized = speaker ? normalizeParticipant(speaker) : null;
          Effect.runSync(
            Effect.gen(function* () {
              yield* SubscriptionRef.update(stateRef, (s) => ({
                ...s,
                activeSpeaker: normalized,
              }));
              yield* logger.debug("Active speaker changed", {
                displayName: normalized?.displayName ?? null,
              });
              yield* PubSub.publish(eventBus, {
                _tag: "ActiveSpeakerChanged",
                participant: normalized,
              });
            })
          );
        });

        return () => {
          unsubJoined();
          unsubLeft();
          unsubUpdated();
          unsubActiveSpeaker();
        };
      });

    return {
      state: SubscriptionRef.get(stateRef),

      stateRef,

      getParticipant: (id) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(participantMapRef);
          return map.get(id);
        }),

      remoteParticipants: Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(stateRef);
        return state.participants.filter((p) => !p.isLocal);
      }),

      attachRoom: (room) =>
        Effect.gen(function* () {
          // Cleanup previous listeners if any
          const prevCleanup = yield* Ref.get(cleanupRef);
          if (prevCleanup) {
            prevCleanup();
          }

          // Sync initial state
          yield* syncFromRoom(room);

          // Setup listeners
          const cleanup = yield* setupRoomListeners(room);
          yield* Ref.set(cleanupRef, cleanup);
        }),

      detach: Effect.gen(function* () {
        const cleanup = yield* Ref.get(cleanupRef);
        if (cleanup) {
          cleanup();
          yield* Ref.set(cleanupRef, null);
        }
        yield* Ref.set(participantMapRef, new Map());
        yield* SubscriptionRef.set(stateRef, initialState);
      }),

      events: Stream.fromPubSub(eventBus),

      dispose: Effect.gen(function* () {
        const cleanup = yield* Ref.get(cleanupRef);
        if (cleanup) {
          cleanup();
        }
        yield* PubSub.shutdown(eventBus);
      }),
    };
  })
);
