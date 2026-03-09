/**
 * RoomInstanceService - Shared reference to the underlying ConferenceSession
 *
 * Holds the ConferenceSession instance that managers depend on.
 * Set by ChalkSession after join, consumed by all manager services.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Context, Effect, Layer, Ref } from "effect";
import type { ConferenceSession } from "../../room";

/**
 * Service holding the shared ConferenceSession reference
 */
export class RoomInstanceService extends Context.Tag("@chalk/RoomInstanceService")<RoomInstanceService, Ref.Ref<ConferenceSession | null>>() {}

/**
 * Create a RoomInstanceService layer
 */
export const RoomInstanceServiceLive = Layer.effect(RoomInstanceService, Ref.make<ConferenceSession | null>(null));

/**
 * Helper: Get current ConferenceSession or fail
 */
export const getRoom = Effect.gen(function* () {
  const roomRef = yield* RoomInstanceService;
  const room = yield* Ref.get(roomRef);
  return room;
});

/**
 * Helper: Get current ConferenceSession, fail if null
 */
export const requireRoom = Effect.gen(function* () {
  const room = yield* getRoom;
  if (!room) {
    return yield* Effect.fail(new Error("Not connected to a room"));
  }
  return room;
});

/**
 * Helper: Set ConferenceSession instance
 */
export const setRoom = (room: ConferenceSession | null) =>
  Effect.gen(function* () {
    const roomRef = yield* RoomInstanceService;
    yield* Ref.set(roomRef, room);
  });
