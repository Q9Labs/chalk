/**
 * Effect Services exports for Chalk SDK managers
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

// ConferenceSession Instance (shared ConferenceSession reference)
export {
  RoomInstanceService,
  RoomInstanceServiceLive,
  getRoom,
  requireRoom,
  setRoom,
} from "./room-instance";

// ConferenceSession Service
export {
  RoomService,
  RoomServiceLive,
  type RoomServiceInterface,
  type JoinOptions,
  type LeaveOptions,
} from "./room-service";

// Participant Service
export {
  ParticipantService,
  ParticipantServiceLive,
  type ParticipantServiceInterface,
} from "./participant-service";

// Media Service
export {
  MediaService,
  MediaServiceLive,
  type MediaServiceInterface,
} from "./media-service";

// Layer composition
export {
  type ManagerServices,
  makeManagerServicesLayer,
  ManagerServicesLive,
  ManagerServicesDebug,
  makeManagerRuntime,
  runManagerEffect,
  getManagerServices,
} from "./manager-layers";
