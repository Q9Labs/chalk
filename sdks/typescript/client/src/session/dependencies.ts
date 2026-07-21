import type { CloudflareSFUBootstrap, CloudflareSFUSnapshot } from "../media";
import type { V3AdmissionPolicy, V3AssignableRole, V3CommandResult, V3SelfMediaTargetResult, V3SessionSnapshot, V3ClientMediaPlane } from "../sync";
import type { ParticipantAccess, ParticipantMediaCredential } from "./access";

export type ChalkSessionAccessReason = "join" | "scheduled_refresh" | "sync_recovery" | "media_recovery";

export type ChalkSessionAccessRequest = {
  readonly reason: ChalkSessionAccessReason;
  readonly replaceMediaConnection: boolean;
  readonly currentMediaToken?: ParticipantMediaCredential;
  readonly expectedParticipantGeneration?: number;
};

export type ChalkSessionAccessProvider = (request?: ChalkSessionAccessRequest) => ParticipantAccess | Promise<ParticipantAccess>;

export type ChalkSessionClock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export type ChalkSessionMediaDevices = {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
};

export type ChalkSessionSyncClient = {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly getSnapshot: () => V3SessionSnapshot;
  readonly subscribe: (listener: (snapshot: V3SessionSnapshot) => void) => () => void;
  readonly leave: () => Promise<V3CommandResult>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<V3SelfMediaTargetResult>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<V3SelfMediaTargetResult>;
  readonly setScreenShareEnabled: (enabled: boolean) => Promise<V3SelfMediaTargetResult>;
  readonly setHandRaised: (raised: boolean) => Promise<V3CommandResult>;
  readonly setDisplayName: (displayName: string) => Promise<V3CommandResult>;
  readonly setAdmissionPolicy: (policy: V3AdmissionPolicy) => Promise<V3CommandResult>;
  readonly setParticipantRole: (participantSessionId: string, role: V3AssignableRole) => Promise<V3CommandResult>;
  readonly transferHost: (participantSessionId: string) => Promise<V3CommandResult>;
  readonly admit: (admissionRequestId: string) => Promise<V3CommandResult>;
  readonly deny: (admissionRequestId: string) => Promise<V3CommandResult>;
  readonly muteParticipant: (participantSessionId: string) => Promise<V3CommandResult>;
  readonly stopParticipantCamera: (participantSessionId: string) => Promise<V3CommandResult>;
  readonly stopParticipantScreenShare: (participantSessionId: string) => Promise<V3CommandResult>;
  readonly removeParticipant: (participantSessionId: string) => Promise<V3CommandResult>;
  readonly endSession: () => Promise<V3CommandResult>;
};

export type ChalkSessionMediaClient = V3ClientMediaPlane & {
  readonly start: (stream: MediaStream) => Promise<void>;
  readonly stop: () => void;
  readonly restart: (input: CloudflareSFUBootstrap) => Promise<void>;
  readonly prepareLocalTrack: (source: "microphone" | "camera" | "screen", track: MediaStreamTrack) => void;
  readonly clearPreparedLocalTrack: (source: "microphone" | "camera" | "screen") => Promise<void>;
  readonly getSnapshot: () => CloudflareSFUSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};

export type ChalkSessionMediaFactoryInput = {
  readonly access: ParticipantAccess;
  readonly credential: () => Promise<string>;
  readonly onFailure: (error: unknown) => void;
  readonly onScreenEnded: () => void;
};

export type ChalkSessionSyncFactoryInput = {
  readonly access: ParticipantAccess;
  readonly token: () => Promise<string>;
  readonly media: ChalkSessionMediaClient;
};

export type ChalkSessionDependencies = {
  readonly clock: ChalkSessionClock;
  readonly mediaDevices: ChalkSessionMediaDevices;
  readonly createMediaClient: (input: ChalkSessionMediaFactoryInput) => ChalkSessionMediaClient;
  readonly createSyncClient: (input: ChalkSessionSyncFactoryInput) => ChalkSessionSyncClient;
};
