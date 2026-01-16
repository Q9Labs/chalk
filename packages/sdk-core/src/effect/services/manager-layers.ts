/**
 * Manager Services Layer composition
 *
 * Provides a combined Layer for all manager services with proper dependency order.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Effect, Layer, ManagedRuntime } from "effect";
import { RoomInstanceService, RoomInstanceServiceLive } from "./room-instance";
import { RoomService, RoomServiceLive } from "./room-service";
import { ParticipantService, ParticipantServiceLive } from "./participant-service";
import { MediaService, MediaServiceLive } from "./media-service";
import { LoggerService, NoopLoggerLive, ConsoleLoggerLive } from "../services";

/**
 * All manager services type
 */
export type ManagerServices =
  | RoomInstanceService
  | RoomService
  | ParticipantService
  | MediaService
  | LoggerService;

/**
 * Create manager services layer with specified logger
 */
export const makeManagerServicesLayer = (debug: boolean) => {
  const loggerLayer = debug ? ConsoleLoggerLive : NoopLoggerLive;

  return Layer.mergeAll(
    RoomServiceLive,
    ParticipantServiceLive,
    MediaServiceLive
  ).pipe(
    Layer.provideMerge(RoomInstanceServiceLive),
    Layer.provideMerge(loggerLayer)
  );
};

/**
 * Default manager services layer (no logging)
 */
export const ManagerServicesLive = makeManagerServicesLayer(false);

/**
 * Debug manager services layer (console logging)
 */
export const ManagerServicesDebug = makeManagerServicesLayer(true);

/**
 * Create a managed runtime for manager services
 */
export const makeManagerRuntime = (debug: boolean) =>
  ManagedRuntime.make(makeManagerServicesLayer(debug));

/**
 * Run an Effect with manager services
 */
export const runManagerEffect = <A, E>(
  effect: Effect.Effect<A, E, ManagerServices>,
  runtime: ManagedRuntime.ManagedRuntime<ManagerServices, never>
) => runtime.runPromise(effect);

/**
 * Helper to get all services from runtime
 */
export const getManagerServices = Effect.all({
  room: RoomService,
  participants: ParticipantService,
  media: MediaService,
  roomInstance: RoomInstanceService,
});
