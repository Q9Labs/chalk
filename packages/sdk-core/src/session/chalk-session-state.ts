import { Effect, type ManagedRuntime } from "effect";
import { MediaService } from "../effect/services/media-service";
import type {
  MediaDeviceData,
  MediaState,
  ParticipantState,
  RoomState,
  VideoBackgroundEffectData,
} from "../effect/schemas/manager-state";
import type { ParticipantService } from "../effect/services/participant-service";
import type { RoomService } from "../effect/services/room-service";
import type { ConferenceSession } from "../room";
import { TypedEventEmitter } from "../utils/typed-emitter";
import type { ChalkError } from "../errors/chalk-error";

export type RoomManagerEvents = {
  connected: { roomId: string };
  disconnected: { reason: string };
  "status:changed": { status: RoomState["status"] };
  "room:ended": { reason: string };
  error: ChalkError;
};

export type ParticipantManagerEvents = {
  "participant:joined": { participant: ParticipantState["participants"][0] };
  "participant:left": { participantId: string };
  "participant:updated": {
    participantId: string;
    participant: ParticipantState["participants"][0];
  };
  "active-speaker:changed": { participant: ParticipantState["activeSpeaker"] };
};

export type MediaManagerEvents = {
  "video:changed": { enabled: boolean; track: MediaStreamTrack | null };
  "audio:changed": { enabled: boolean; track: MediaStreamTrack | null };
  "devices:changed": { devices: readonly MediaDeviceData[] };
  error: ChalkError;
};

export interface RoomSessionApi {
  readonly getState: () => RoomState;
  readonly getRoom: () => ConferenceSession | null;
  readonly on: <K extends keyof RoomManagerEvents>(event: K, handler: (data: RoomManagerEvents[K]) => void) => () => void;
  readonly subscribe: (listener: (state: RoomState, prevState: RoomState) => void) => () => void;
  _state: RoomState;
  _emitter: TypedEventEmitter<RoomManagerEvents>;
  _listeners: Set<(state: RoomState, prevState: RoomState) => void>;
}

export interface ParticipantSessionApi {
  readonly getState: () => ParticipantState;
  readonly on: <K extends keyof ParticipantManagerEvents>(event: K, handler: (data: ParticipantManagerEvents[K]) => void) => () => void;
  readonly subscribe: (listener: (state: ParticipantState, prevState: ParticipantState) => void) => () => void;
  readonly getParticipant: (id: string) => ParticipantState["participants"][0] | undefined;
  readonly remoteParticipants: readonly ParticipantState["participants"][0][];
  _state: ParticipantState;
  _emitter: TypedEventEmitter<ParticipantManagerEvents>;
  _listeners: Set<(state: ParticipantState, prevState: ParticipantState) => void>;
}

export interface MediaSessionApi {
  readonly getState: () => MediaState;
  readonly on: <K extends keyof MediaManagerEvents>(event: K, handler: (data: MediaManagerEvents[K]) => void) => () => void;
  readonly subscribe: (listener: (state: MediaState, prevState: MediaState) => void) => () => void;
  readonly toggleVideo: () => Promise<boolean>;
  readonly toggleAudio: () => Promise<boolean>;
  readonly applyBackgroundEffect: (effect: VideoBackgroundEffectData) => Promise<void>;
  readonly clearBackgroundEffect: () => Promise<void>;
  readonly selectCamera: (deviceId: string) => Promise<void>;
  readonly selectMicrophone: (deviceId: string) => Promise<void>;
  readonly selectSpeaker: (deviceId: string) => Promise<void>;
  readonly undoDeviceChange: () => void;
  readonly refreshDevices: () => Promise<readonly MediaDeviceData[]>;
  readonly cameras: readonly MediaDeviceData[];
  readonly microphones: readonly MediaDeviceData[];
  readonly speakers: readonly MediaDeviceData[];
  _state: MediaState;
  _emitter: TypedEventEmitter<MediaManagerEvents>;
  _listeners: Set<(state: MediaState, prevState: MediaState) => void>;
}

export const createDefaultRoomState = (): RoomState => ({
  status: "disconnected",
  roomId: null,
  roomName: null,
  isJoining: false,
  hostId: null,
});

export const createDefaultParticipantState = (): ParticipantState => ({
  participants: [],
  activeSpeaker: null,
  localParticipant: null,
  count: 0,
});

export const createDefaultMediaState = (): MediaState => ({
  isVideoEnabled: false,
  isAudioEnabled: false,
  isTogglingVideo: false,
  isTogglingAudio: false,
  isBackgroundEffectsSupported: false,
  isApplyingBackgroundEffect: false,
  selectedCamera: null,
  selectedMicrophone: null,
  selectedSpeaker: null,
  selectedBackgroundEffect: { mode: "none" },
  devices: [],
});

export interface SessionStateUpdaters {
  updateRoomState: (newState: RoomState) => void;
  updateParticipantState: (newState: ParticipantState) => void;
  updateMediaState: (newState: MediaState) => void;
}

interface CreateSessionStateApisArgs {
  runtime: ManagedRuntime.ManagedRuntime<RoomService | ParticipantService | MediaService, never>;
  getCurrentRoom: () => ConferenceSession | null;
}

export const createSessionStateApis = (
  args: CreateSessionStateApisArgs,
): {
  room: RoomSessionApi;
  participants: ParticipantSessionApi;
  media: MediaSessionApi;
  updaters: SessionStateUpdaters;
} => {
  const roomEmitter = new TypedEventEmitter<RoomManagerEvents>();
  const participantEmitter = new TypedEventEmitter<ParticipantManagerEvents>();
  const mediaEmitter = new TypedEventEmitter<MediaManagerEvents>();

  const roomListeners = new Set<(state: RoomState, prevState: RoomState) => void>();
  const participantListeners = new Set<(state: ParticipantState, prevState: ParticipantState) => void>();
  const mediaListeners = new Set<(state: MediaState, prevState: MediaState) => void>();

  const room: RoomSessionApi = {
    _state: createDefaultRoomState(),
    _emitter: roomEmitter,
    _listeners: roomListeners,
    getState: () => room._state,
    getRoom: () => args.getCurrentRoom(),
    on: <K extends keyof RoomManagerEvents>(event: K, handler: (data: RoomManagerEvents[K]) => void) => room._emitter.on(event, handler),
    subscribe: (listener: (state: RoomState, prevState: RoomState) => void) => {
      roomListeners.add(listener);
      return () => {
        roomListeners.delete(listener);
      };
    },
  };

  const participants: ParticipantSessionApi = {
    _state: createDefaultParticipantState(),
    _emitter: participantEmitter,
    _listeners: participantListeners,
    getState: () => participants._state,
    on: <K extends keyof ParticipantManagerEvents>(event: K, handler: (data: ParticipantManagerEvents[K]) => void) => participants._emitter.on(event, handler),
    subscribe: (listener: (state: ParticipantState, prevState: ParticipantState) => void) => {
      participantListeners.add(listener);
      return () => {
        participantListeners.delete(listener);
      };
    },
    getParticipant: (id: string) => participants._state.participants.find((p) => p.id === id),
    get remoteParticipants() {
      return participants._state.participants.filter((p) => !p.isLocal);
    },
  };

  const media: MediaSessionApi = {
    _state: createDefaultMediaState(),
    _emitter: mediaEmitter,
    _listeners: mediaListeners,
    getState: () => media._state,
    on: <K extends keyof MediaManagerEvents>(event: K, handler: (data: MediaManagerEvents[K]) => void) => media._emitter.on(event, handler),
    subscribe: (listener: (state: MediaState, prevState: MediaState) => void) => {
      mediaListeners.add(listener);
      return () => {
        mediaListeners.delete(listener);
      };
    },
    toggleVideo: async () => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          return yield* mediaSvc.toggleVideo;
        }),
      );
    },
    toggleAudio: async () => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          return yield* mediaSvc.toggleAudio;
        }),
      );
    },
    applyBackgroundEffect: async (effect) => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.applyBackgroundEffect(effect);
        }),
      );
    },
    clearBackgroundEffect: async () => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.clearBackgroundEffect;
        }),
      );
    },
    selectCamera: async (deviceId: string) => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.selectCamera(deviceId);
        }),
      );
    },
    selectMicrophone: async (deviceId: string) => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.selectMicrophone(deviceId);
        }),
      );
    },
    selectSpeaker: async (deviceId: string) => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.selectSpeaker(deviceId);
        }),
      );
    },
    undoDeviceChange: () => {
      args.runtime.runSync(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          yield* mediaSvc.undoDeviceChange;
        }),
      );
    },
    refreshDevices: async () => {
      return args.runtime.runPromise(
        Effect.gen(function* () {
          const mediaSvc = yield* MediaService;
          return yield* mediaSvc.refreshDevices;
        }),
      );
    },
    get cameras() {
      return media._state.devices.filter((device) => device.kind === "videoinput");
    },
    get microphones() {
      return media._state.devices.filter((device) => device.kind === "audioinput");
    },
    get speakers() {
      return media._state.devices.filter((device) => device.kind === "audiooutput");
    },
  };

  const updateRoomState = (newState: RoomState): void => {
    const prevState = room._state;
    room._state = newState;
    roomListeners.forEach((listener) => {
      try {
        listener(newState, prevState);
      } catch {
        // Silently catch listener errors
      }
    });
  };

  const updateParticipantState = (newState: ParticipantState): void => {
    const prevState = participants._state;
    participants._state = newState;
    participantListeners.forEach((listener) => {
      try {
        listener(newState, prevState);
      } catch {
        // Silently catch listener errors
      }
    });
  };

  const updateMediaState = (newState: MediaState): void => {
    const prevState = media._state;
    media._state = newState;
    mediaListeners.forEach((listener) => {
      try {
        listener(newState, prevState);
      } catch {
        // Silently catch listener errors
      }
    });
  };

  return {
    room,
    participants,
    media,
    updaters: {
      updateRoomState,
      updateParticipantState,
      updateMediaState,
    },
  };
};
