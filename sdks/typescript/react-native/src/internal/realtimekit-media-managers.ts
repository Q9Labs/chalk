import type { MediaDevice, MediaState, ScreenShareOptions, ScreenShareState, VideoBackgroundEffect } from "./core";
import { ChalkErrorClass } from "./core";
import { ObservableManager } from "./observable-manager";
import type { RealtimeKitMeeting, RealtimeKitSelf } from "./realtimekit-ports";
import { projectDevice } from "./realtimekit-ports";

const emptyMediaState: MediaState = {
  devices: [],
  cameras: [],
  microphones: [],
  speakers: [],
  selectedCameraId: null,
  selectedMicrophoneId: null,
  selectedSpeakerId: null,
  selectedBackgroundEffect: { id: "none", type: "none" },
  selectedCamera: null,
  selectedMicrophone: null,
  selectedSpeaker: null,
  isBackgroundEffectsSupported: false,
  isApplyingBackgroundEffect: false,
  isVideoEnabled: false,
  isAudioEnabled: false,
  isTogglingVideo: false,
  isTogglingAudio: false,
};

export class MediaManager extends ObservableManager<MediaState> {
  cameras: readonly MediaDevice[] = [];
  microphones: readonly MediaDevice[] = [];
  speakers: readonly MediaDevice[] = [];
  #self: RealtimeKitSelf | null = null;
  #previousDevice: Partial<Record<"camera" | "microphone" | "speaker", string>> = {};

  constructor() {
    super(emptyMediaState);
  }

  attach(self: RealtimeKitSelf): void {
    this.#self = self;
    this.sync(self);
    void this.refreshDevices().catch(() => undefined);
  }

  detach(): void {
    this.#self = null;
    this.cameras = [];
    this.microphones = [];
    this.speakers = [];
    this.replaceState(emptyMediaState);
  }

  sync(self: RealtimeKitSelf): void {
    this.patchState({
      isAudioEnabled: Boolean(self.audioEnabled),
      isVideoEnabled: Boolean(self.videoEnabled),
    });
  }

  toggleAudio = async (): Promise<boolean> => {
    const self = this.#requireSelf();
    const enabled = !self.audioEnabled;
    this.patchState({ isTogglingAudio: true });
    try {
      if (enabled) await self.enableAudio();
      else await self.disableAudio();
      this.sync(self);
      return enabled;
    } finally {
      this.patchState({ isTogglingAudio: false });
    }
  };

  toggleVideo = async (): Promise<boolean> => {
    const self = this.#requireSelf();
    const enabled = !self.videoEnabled;
    this.patchState({ isTogglingVideo: true });
    try {
      if (enabled) await self.enableVideo();
      else await self.disableVideo();
      this.sync(self);
      return enabled;
    } finally {
      this.patchState({ isTogglingVideo: false });
    }
  };

  refreshDevices = async (): Promise<readonly MediaDevice[]> => {
    const self = this.#requireSelf();
    const devices = (await self.getAllDevices()).map(projectDevice);
    this.cameras = devices.filter((device) => device.kind === "camera");
    this.microphones = devices.filter((device) => device.kind === "microphone");
    this.speakers = devices.filter((device) => device.kind === "speaker");
    this.patchState({ devices, cameras: this.cameras, microphones: this.microphones, speakers: this.speakers });
    return devices;
  };

  selectCamera = (deviceId: string): Promise<void> => this.#selectDevice("camera", "video", deviceId);
  selectMicrophone = (deviceId: string): Promise<void> => this.#selectDevice("microphone", "audio", deviceId);
  selectSpeaker = (deviceId: string): Promise<void> => this.#selectDevice("speaker", "speaker", deviceId);

  undoDeviceChange = (): void => {
    const entries = Object.entries(this.#previousDevice) as ["camera" | "microphone" | "speaker", string][];
    for (const [kind, deviceId] of entries) {
      const realtimeKitKind = kind === "camera" ? "video" : kind === "microphone" ? "audio" : "speaker";
      void this.#selectDevice(kind, realtimeKitKind, deviceId);
    }
  };

  applyBackgroundEffect = (_effect: VideoBackgroundEffect): Promise<void> => Promise.reject(new ChalkErrorClass("Native background effects are unavailable in this native runtime"));
  clearBackgroundEffect = (): Promise<void> => Promise.resolve();

  async #selectDevice(kind: "camera" | "microphone" | "speaker", realtimeKitKind: "audio" | "video" | "speaker", deviceId: string): Promise<void> {
    const self = this.#requireSelf();
    const stateKey = kind === "camera" ? "selectedCamera" : kind === "microphone" ? "selectedMicrophone" : "selectedSpeaker";
    const idKey = kind === "camera" ? "selectedCameraId" : kind === "microphone" ? "selectedMicrophoneId" : "selectedSpeakerId";
    const current = this.getState()[stateKey];
    if (current) this.#previousDevice[kind] = current;
    await self.setDevice(await self.getDeviceById(deviceId, realtimeKitKind));
    this.patchState({ [stateKey]: deviceId, [idKey]: deviceId });
  }

  #requireSelf(): RealtimeKitSelf {
    if (!this.#self) throw new ChalkErrorClass("The native meeting is not connected");
    return this.#self;
  }
}

const emptyScreenShareState: ScreenShareState = {
  isActive: false,
  isLocalSharing: false,
  isStarting: false,
  sharerParticipantId: null,
  videoTrack: null,
  audioTrack: null,
};

export class ScreenShareManager extends ObservableManager<ScreenShareState> {
  #self: RealtimeKitSelf | null = null;
  #onChange: (() => void) | null = null;

  constructor() {
    super(emptyScreenShareState);
  }

  attach(self: RealtimeKitSelf, onChange: () => void): void {
    this.#self = self;
    this.#onChange = onChange;
  }

  detach(): void {
    this.#self = null;
    this.#onChange = null;
    this.replaceState(emptyScreenShareState);
  }

  sync(meeting: RealtimeKitMeeting): void {
    const remoteSharer = meeting.participants.joined.toArray().find((participant) => participant.screenShareEnabled);
    const isLocalSharing = Boolean(meeting.self.screenShareEnabled);
    const source = isLocalSharing ? meeting.self : remoteSharer;
    this.replaceState({
      isActive: Boolean(source),
      isLocalSharing,
      isStarting: false,
      sharerParticipantId: source?.id ?? null,
      videoTrack: source?.screenShareTracks?.video ?? null,
      audioTrack: source?.screenShareTracks?.audio ?? null,
    });
  }

  start = async (_options?: ScreenShareOptions): Promise<boolean> => {
    const self = this.#requireSelf();
    this.patchState({ isStarting: true });
    try {
      await self.enableScreenShare();
      this.#onChange?.();
      return true;
    } finally {
      this.patchState({ isStarting: false });
    }
  };

  stop = async (): Promise<void> => {
    const self = this.#requireSelf();
    await self.disableScreenShare();
    this.#onChange?.();
  };

  #requireSelf(): RealtimeKitSelf {
    if (!this.#self) throw new ChalkErrorClass("The native meeting is not connected");
    return this.#self;
  }
}
