import type { MediaDevice, Participant } from "./core";

export type RealtimeKitEventHandler = (...args: unknown[]) => void;

export interface RealtimeKitEventSource {
  on(event: string, handler: RealtimeKitEventHandler): unknown;
  off(event: string, handler: RealtimeKitEventHandler): unknown;
}

export interface RealtimeKitDevice {
  readonly deviceId: string;
  readonly kind: string;
  readonly label: string;
}

export interface RealtimeKitParticipant extends RealtimeKitEventSource {
  readonly id: string;
  readonly name?: string;
  readonly isHost?: boolean;
  readonly audioEnabled?: boolean;
  readonly videoEnabled?: boolean;
  readonly audioTrack?: MediaStreamTrack;
  readonly videoTrack?: MediaStreamTrack;
  readonly screenShareEnabled?: boolean;
  readonly screenShareTracks?: {
    readonly audio?: MediaStreamTrack;
    readonly video?: MediaStreamTrack;
  };
}

export interface RealtimeKitParticipantMap extends RealtimeKitEventSource {
  get(id: string): RealtimeKitParticipant | undefined;
  toArray(): RealtimeKitParticipant[];
}

export interface RealtimeKitSelf extends RealtimeKitParticipant {
  readonly roomJoined?: boolean;
  getAllDevices(): Promise<RealtimeKitDevice[]>;
  getDeviceById(deviceId: string, kind: "audio" | "video" | "speaker"): Promise<RealtimeKitDevice>;
  setDevice(device: RealtimeKitDevice): Promise<void>;
  setName(name: string): void;
  enableAudio(): Promise<void>;
  disableAudio(): Promise<void>;
  enableVideo(): Promise<void>;
  disableVideo(): Promise<void>;
  enableScreenShare(): Promise<void>;
  disableScreenShare(): Promise<void>;
}

export interface RealtimeKitMeeting {
  readonly self: RealtimeKitSelf;
  readonly participants: RealtimeKitEventSource & {
    readonly joined: RealtimeKitParticipantMap;
  };
  readonly meta?: RealtimeKitEventSource & {
    readonly meetingId?: string;
    readonly meetingTitle?: string;
    readonly socketState?: {
      readonly state: "connected" | "disconnected" | "reconnecting" | "failed";
      readonly reconnected: boolean;
      readonly reconnectionAttempt: number;
    };
  };
  join(): Promise<void>;
  leave(): Promise<void>;
}

export interface RealtimeKitModule {
  init(options: {
    readonly authToken: string;
    readonly defaults: {
      readonly audio: boolean;
      readonly video: boolean;
    };
    readonly onError: (error: unknown) => void;
  }): Promise<RealtimeKitMeeting>;
}

export function listen(source: RealtimeKitEventSource, event: string, handler: RealtimeKitEventHandler): () => void {
  source.on(event, handler);
  return () => source.off(event, handler);
}

export function projectParticipant(participant: RealtimeKitParticipant, role?: Participant["role"]): Participant {
  return {
    id: participant.id,
    displayName: participant.name?.trim() || "Guest",
    role: role ?? (participant.isHost ? "host" : "participant"),
    audioEnabled: Boolean(participant.audioEnabled),
    videoEnabled: Boolean(participant.videoEnabled),
    audioTrack: participant.audioTrack ?? null,
    videoTrack: participant.videoTrack ?? null,
    screenShareTrack: participant.screenShareTracks?.video ?? null,
  };
}

export function projectDevice(device: RealtimeKitDevice): MediaDevice {
  const kind = device.kind === "videoinput" ? "camera" : device.kind === "audiooutput" ? "speaker" : "microphone";
  return { id: device.deviceId, label: device.label || device.deviceId, kind };
}

export function isRealtimeKitModule(value: unknown): value is RealtimeKitModule {
  return typeof value === "object" && value !== null && typeof (value as { init?: unknown }).init === "function";
}

export function socketConnectionState(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const state = (value as { state?: unknown }).state;
  return typeof state === "string" ? state : null;
}
