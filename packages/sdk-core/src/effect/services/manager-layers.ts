/**
 * Manager Services Layer composition
 *
 * Provides a combined Layer for all manager services with proper dependency order.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Layer } from "effect";
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
