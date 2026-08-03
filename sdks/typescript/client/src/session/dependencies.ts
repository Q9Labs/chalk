import type { CloudflareSFUBootstrap, CloudflareSFUSnapshot } from "../media";
import type { ChalkChatFileTransport } from "../chat-files";
import type { V1AdmissionPolicy, V1AssignableRole, V1CommandResult, V1SelfMediaTargetResult, V1SessionSnapshot, V1ClientMediaPlane } from "../sync";
import type { V1DirectedRequest, V1DirectedRequestResult, V1RoomActionsClient } from "../sync/v1-types";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "../whiteboard/types";
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

export type ChalkSessionSyncClient = V1RoomActionsClient & {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly getSnapshot: () => V1SessionSnapshot;
  readonly subscribe: (listener: (snapshot: V1SessionSnapshot) => void) => () => void;
  readonly leave: () => Promise<V1CommandResult>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setScreenShareEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setHandRaised: (raised: boolean) => Promise<V1CommandResult>;
  readonly setDisplayName: (displayName: string) => Promise<V1CommandResult>;
  readonly setAdmissionPolicy: (policy: V1AdmissionPolicy) => Promise<V1CommandResult>;
  readonly setParticipantRole: (participantSessionId: string, role: V1AssignableRole) => Promise<V1CommandResult>;
  readonly transferHost: (participantSessionId: string) => Promise<V1CommandResult>;
  readonly admit: (admissionRequestId: string) => Promise<V1CommandResult>;
  readonly deny: (admissionRequestId: string) => Promise<V1CommandResult>;
  readonly muteParticipant: (participantSessionId: string) => Promise<V1CommandResult>;
  readonly stopParticipantCamera: (participantSessionId: string) => Promise<V1CommandResult>;
  readonly stopParticipantScreenShare: (participantSessionId: string) => Promise<V1CommandResult>;
  readonly removeParticipant: (participantSessionId: string) => Promise<V1CommandResult>;
  readonly endSession: () => Promise<V1CommandResult>;
  readonly onDirectedRequest: (listener: (request: V1DirectedRequest) => void) => () => void;
  readonly requestUnmute: (participantSessionId: string) => Promise<V1DirectedRequestResult>;
  readonly requestStartCamera: (participantSessionId: string) => Promise<V1DirectedRequestResult>;
};

export type ChalkSessionMediaClient = V1ClientMediaPlane & {
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

export type ChalkSessionWhiteboardFactoryInput = {
  readonly token: () => Promise<string>;
  readonly onSummary: (summary: ChalkWhiteboardSummary) => void;
};

export type ChalkSessionChatFileFactoryInput = {
  readonly token: () => Promise<string>;
};

export type ChalkSessionDependencies = {
  readonly clock: ChalkSessionClock;
  readonly mediaDevices: ChalkSessionMediaDevices;
  readonly createMediaClient: (input: ChalkSessionMediaFactoryInput) => ChalkSessionMediaClient;
  readonly createSyncClient: (input: ChalkSessionSyncFactoryInput) => ChalkSessionSyncClient;
  readonly createChatFileTransport?: (input: ChalkSessionChatFileFactoryInput) => ChalkChatFileTransport | null;
  readonly createWhiteboardClient?: (input: ChalkSessionWhiteboardFactoryInput) => ChalkWhiteboardV1Transport | null;
};
