/**
 * MediaService - Effect-based media management
 *
 * Replaces MediaManager with Effect patterns:
 * - SubscriptionRef for observable state
 * - PubSub for typed events
 * - Semaphore for toggle serialization (prevents concurrent toggles)
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/services
 */

import { Context, Effect, Layer, PubSub, Ref, Stream, SubscriptionRef } from "effect";
import type { Room } from "../../room";
import { MediaError, RoomError } from "../errors";
import { LoggerService } from "../services";
import type { MediaEvent, MediaState, MediaDeviceData } from "../schemas/manager-state";
import { RoomInstanceService } from "./room-instance";

/** Previous device for undo functionality */
interface PreviousDevice {
  type: "camera" | "microphone";
  id: string;
}

/** Initial media state */
const initialState: MediaState = {
  isVideoEnabled: false,
  isAudioEnabled: false,
  isTogglingVideo: false,
  isTogglingAudio: false,
  selectedCamera: null,
  selectedMicrophone: null,
  selectedSpeaker: null,
  devices: [],
};

/**
 * MediaService interface
 */
export interface MediaServiceInterface {
  /** Get current state */
  readonly state: Effect.Effect<MediaState>;
  /** Subscribe to state via SubscriptionRef */
  readonly stateRef: SubscriptionRef.SubscriptionRef<MediaState>;
  /** Toggle video (serialized via Semaphore) */
  readonly toggleVideo: Effect.Effect<boolean, MediaError | RoomError>;
  /** Toggle audio (serialized via Semaphore) */
  readonly toggleAudio: Effect.Effect<boolean, MediaError | RoomError>;
  /** Select camera */
  readonly selectCamera: (deviceId: string) => Effect.Effect<void, RoomError>;
  /** Select microphone */
  readonly selectMicrophone: (deviceId: string) => Effect.Effect<void, RoomError>;
  /** Select speaker */
  readonly selectSpeaker: (deviceId: string) => Effect.Effect<void>;
  /** Undo last device change (within 5s) */
  readonly undoDeviceChange: Effect.Effect<void>;
  /** Refresh available devices */
  readonly refreshDevices: Effect.Effect<readonly MediaDeviceData[], MediaError>;
  /** Get cameras */
  readonly cameras: Effect.Effect<readonly MediaDeviceData[]>;
  /** Get microphones */
  readonly microphones: Effect.Effect<readonly MediaDeviceData[]>;
  /** Get speakers */
  readonly speakers: Effect.Effect<readonly MediaDeviceData[]>;
  /** Attach to room */
  readonly attachRoom: (room: Room) => Effect.Effect<void>;
  /** Stream of media events */
  readonly events: Stream.Stream<MediaEvent>;
  /** Dispose resources */
  readonly dispose: Effect.Effect<void>;
}

/**
 * MediaService Context Tag
 */
export class MediaService extends Context.Tag("@chalk/MediaService")<
  MediaService,
  MediaServiceInterface
>() {}

/**
 * MediaService Live implementation
 */
export const MediaServiceLive = Layer.effect(
  MediaService,
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    const roomRef = yield* RoomInstanceService;

    // State via SubscriptionRef
    const stateRef = yield* SubscriptionRef.make<MediaState>(initialState);

    // Event bus
    const eventBus = yield* PubSub.unbounded<MediaEvent>();

    // Semaphores for toggle serialization (separate for video/audio)
    const videoSemaphore = yield* Effect.makeSemaphore(1);
    const audioSemaphore = yield* Effect.makeSemaphore(1);

    // Undo state
    const previousDeviceRef = yield* Ref.make<PreviousDevice | null>(null);
    const undoTimerRef = yield* Ref.make<ReturnType<typeof setTimeout> | null>(null);

    const requireRoom = Effect.gen(function* () {
      const room = yield* Ref.get(roomRef);
      if (!room) {
        return yield* Effect.fail(
          new RoomError({
            code: "NOT_IN_ROOM",
            message: "Not connected to a room",
            recoverable: false,
          })
        );
      }
      return room;
    });

    const startUndoTimer = Effect.gen(function* () {
      // Clear existing timer
      const existingTimer = yield* Ref.get(undoTimerRef);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Start new 5s timer
      const timer = setTimeout(() => {
        Effect.runSync(
          Effect.gen(function* () {
            yield* Ref.set(previousDeviceRef, null);
            yield* Ref.set(undoTimerRef, null);
          })
        );
      }, 5000);

      yield* Ref.set(undoTimerRef, timer);
    });

    return {
      state: SubscriptionRef.get(stateRef),

      stateRef,

      toggleVideo: videoSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const room = yield* requireRoom;

          yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, isTogglingVideo: true }));

          const result = yield* Effect.tryPromise({
            try: () => room.toggleVideo(),
            catch: (err) =>
              new MediaError({
                code: "DEVICE_NOT_FOUND",
                message: err instanceof Error ? err.message : "Video toggle failed",
                recoverable: true,
              }),
          });

          const track = room.localParticipant?.videoTrack ?? null;

          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            isVideoEnabled: result,
            isTogglingVideo: false,
          }));

          yield* logger.info("Video toggled", { enabled: result });
          yield* PubSub.publish(eventBus, { _tag: "VideoChanged", enabled: result, track });

          return result;
        }).pipe(
          Effect.tapError(() =>
            SubscriptionRef.update(stateRef, (s) => ({ ...s, isTogglingVideo: false }))
          )
        )
      ),

      toggleAudio: audioSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const room = yield* requireRoom;

          yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, isTogglingAudio: true }));

          const result = yield* Effect.tryPromise({
            try: () => room.toggleAudio(),
            catch: (err) =>
              new MediaError({
                code: "DEVICE_NOT_FOUND",
                message: err instanceof Error ? err.message : "Audio toggle failed",
                recoverable: true,
              }),
          });

          const track = room.localParticipant?.audioTrack ?? null;

          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            isAudioEnabled: result,
            isTogglingAudio: false,
          }));

          yield* logger.info("Audio toggled", { enabled: result });
          yield* PubSub.publish(eventBus, { _tag: "AudioChanged", enabled: result, track });

          return result;
        }).pipe(
          Effect.tapError(() =>
            SubscriptionRef.update(stateRef, (s) => ({ ...s, isTogglingAudio: false }))
          )
        )
      ),

      selectCamera: (deviceId) =>
        Effect.gen(function* () {
          const room = yield* requireRoom;
          const current = yield* SubscriptionRef.get(stateRef);

          // Store previous for undo
          yield* Ref.set(previousDeviceRef, {
            type: "camera" as const,
            id: current.selectedCamera ?? "",
          });

          yield* Effect.tryPromise({
            try: () => room.selectCamera(deviceId),
            catch: (err) =>
              new RoomError({
                code: "NOT_IN_ROOM",
                message: err instanceof Error ? err.message : "Failed to select camera",
                recoverable: false,
              }),
          });
          yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, selectedCamera: deviceId }));
          yield* logger.info("Camera selected", { deviceId });
          yield* startUndoTimer;
        }),

      selectMicrophone: (deviceId) =>
        Effect.gen(function* () {
          const room = yield* requireRoom;
          const current = yield* SubscriptionRef.get(stateRef);

          // Store previous for undo
          yield* Ref.set(previousDeviceRef, {
            type: "microphone" as const,
            id: current.selectedMicrophone ?? "",
          });

          yield* Effect.tryPromise({
            try: () => room.selectMicrophone(deviceId),
            catch: (err) =>
              new RoomError({
                code: "NOT_IN_ROOM",
                message: err instanceof Error ? err.message : "Failed to select microphone",
                recoverable: false,
              }),
          });
          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            selectedMicrophone: deviceId,
          }));
          yield* logger.info("Microphone selected", { deviceId });
          yield* startUndoTimer;
        }),

      selectSpeaker: (deviceId) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, selectedSpeaker: deviceId }));
        }),

      undoDeviceChange: Effect.gen(function* () {
        const previousDevice = yield* Ref.get(previousDeviceRef);
        const undoTimer = yield* Ref.get(undoTimerRef);
        const room = yield* Ref.get(roomRef);

        if (!previousDevice || !undoTimer || !room) {
          return;
        }

        clearTimeout(undoTimer);

        if (previousDevice.type === "camera") {
          yield* Effect.tryPromise(() => room.selectCamera(previousDevice.id)).pipe(
            Effect.catchAll(() => Effect.void)
          );
          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            selectedCamera: previousDevice.id,
          }));
        } else if (previousDevice.type === "microphone") {
          yield* Effect.tryPromise(() => room.selectMicrophone(previousDevice.id)).pipe(
            Effect.catchAll(() => Effect.void)
          );
          yield* SubscriptionRef.update(stateRef, (s) => ({
            ...s,
            selectedMicrophone: previousDevice.id,
          }));
        }

        yield* Ref.set(previousDeviceRef, null);
        yield* Ref.set(undoTimerRef, null);
      }),

      refreshDevices: Effect.gen(function* () {
        const rawDevices = yield* Effect.tryPromise({
          try: () => navigator.mediaDevices.enumerateDevices(),
          catch: (err) =>
            new MediaError({
              code: "DEVICE_NOT_FOUND",
              message: err instanceof Error ? err.message : "Device enumeration failed",
              recoverable: true,
            }),
        });

        const devices: MediaDeviceData[] = rawDevices
          .filter((d) => ["videoinput", "audioinput", "audiooutput"].includes(d.kind))
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
            kind: d.kind as "videoinput" | "audioinput" | "audiooutput",
          }));

        yield* SubscriptionRef.update(stateRef, (s) => ({ ...s, devices }));
        yield* PubSub.publish(eventBus, { _tag: "DevicesChanged", devices });

        return devices;
      }),

      cameras: Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(stateRef);
        return state.devices.filter((d) => d.kind === "videoinput");
      }),

      microphones: Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(stateRef);
        return state.devices.filter((d) => d.kind === "audioinput");
      }),

      speakers: Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(stateRef);
        return state.devices.filter((d) => d.kind === "audiooutput");
      }),

      attachRoom: (room) =>
        Effect.gen(function* () {
          const localParticipant = room.localParticipant;
          if (localParticipant) {
            yield* SubscriptionRef.update(stateRef, (s) => ({
              ...s,
              isVideoEnabled: localParticipant.videoEnabled ?? false,
              isAudioEnabled: localParticipant.audioEnabled ?? false,
            }));
          }
        }),

      events: Stream.fromPubSub(eventBus),

      dispose: Effect.gen(function* () {
        const timer = yield* Ref.get(undoTimerRef);
        if (timer) {
          clearTimeout(timer);
        }
        yield* PubSub.shutdown(eventBus);
      }),
    };
  })
);
