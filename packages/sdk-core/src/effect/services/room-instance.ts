/**
 * RoomInstanceService - Shared reference to the underlying Room
 *
 * Holds the Room instance that managers depend on.
 * Set by ChalkSession after join, consumed by all manager services.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Context, Effect, Layer, Ref } from "effect";
import type { Room } from "../../room";

/**
 * Service holding the shared Room reference
 */
export class RoomInstanceService extends Context.Tag("@chalk/RoomInstanceService")<
  RoomInstanceService,
  Ref.Ref<Room | null>
>() {}

/**
 * Create a RoomInstanceService layer
 */
export const RoomInstanceServiceLive = Layer.effect(
  RoomInstanceService,
  Ref.make<Room | null>(null)
);

/**
 * Helper: Get current Room or fail
 */
export const getRoom = Effect.gen(function* () {
  const roomRef = yield* RoomInstanceService;
  const room = yield* Ref.get(roomRef);
  return room;
});

/**
 * Helper: Get current Room, fail if null
 */
export const requireRoom = Effect.gen(function* () {
  const room = yield* getRoom;
  if (!room) {
    return yield* Effect.fail(new Error("Not connected to a room"));
  }
  return room;
});

/**
 * Helper: Set Room instance
 */
export const setRoom = (room: Room | null) =>
  Effect.gen(function* () {
    const roomRef = yield* RoomInstanceService;
    yield* Ref.set(roomRef, room);
  });
