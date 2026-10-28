import type { ParticipantEpisodeStatus } from "../generated/schemas";
import type { ConnectionReporter, ConnectionReportTransportEvent } from "./report";
import type { ClientMediaPlane, CloudflareSFUBootstrap, ConnectionMediaSnapshot } from "../media";
import type { ChalkChatFileTransport } from "../chat-files";
import type { V1AdmissionTarget, V1AssignableRole, V1CommandResult, V1EpisodeSnapshot, V1SelfMediaTargetResult } from "../sync";
import type { V1CollaborationClient, V1DirectedRequest, V1DirectedRequestResult, V1MediaPause } from "../sync/v1-types";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1ClientOptions, ChalkWhiteboardV1Transport } from "../whiteboard/types";
import type { ParsedAccessGrant, ParticipantMediaAccess, ParticipantMediaCredential } from "../access/grant";
import { Context, Layer } from "effect";
export type ConnectionAccessReason = "join" | "scheduled_refresh" | "sync_recovery" | "media_recovery" | "access_retry";
export type ConnectionAccessRequest = {
  readonly reason: ConnectionAccessReason;
  readonly replaceMediaConnection: boolean;
  readonly signal?: AbortSignal;
  readonly currentMediaToken?: ParticipantMediaCredential;
  readonly expectedParticipantGeneration?: number;
  readonly expectedMediaConnectionId?: string;
};
export type ConnectionAccessProvider = (request?: ConnectionAccessRequest) => ParsedAccessGrant | Promise<ParsedAccessGrant>;
export type ConnectionClock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};
export type ConnectionMediaDevices = {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly enumerateDevices?: () => Promise<readonly MediaDeviceInfo[]>;
  /**
   * An application-provided output sink selector. Browser capture APIs have no
   * global speaker switch, so an application that renders remote audio supplies the
   * element-specific implementation here.
   */
  readonly selectSpeaker?: (deviceId: string) => Promise<void>;
};
export type ConnectionSyncClient = V1CollaborationClient & {
  readonly start: () => Promise<void>;
  /** Confirms entry after Sync is live and media has started. Without it, Sync confirms the entry at hello. */
  readonly confirmEntered?: () => Promise<void>;
  readonly restartTransport?: () => void;
  readonly stop: () => void;
  readonly getSnapshot: () => V1EpisodeSnapshot;
  readonly subscribe: (listener: (snapshot: V1EpisodeSnapshot) => void) => () => void;
  readonly leave: () => Promise<V1CommandResult>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setScreenShareEnabled: (enabled: boolean) => Promise<V1SelfMediaTargetResult>;
  readonly setHandRaised: (raised: boolean) => Promise<V1CommandResult>;
  readonly setDisplayName: (displayName: string) => Promise<V1CommandResult>;
  readonly setAdmissionPolicy: (policy: V1AdmissionTarget) => Promise<V1CommandResult>;
  readonly assignRole: (participantId: string, role: V1AssignableRole) => Promise<V1CommandResult>;
  readonly admit: (admissionRequestId: string) => Promise<V1CommandResult>;
  readonly deny: (admissionRequestId: string) => Promise<V1CommandResult>;
  readonly muteParticipant: (participantId: string) => Promise<V1CommandResult>;
  readonly stopParticipantCamera: (participantId: string) => Promise<V1CommandResult>;
  readonly stopParticipantScreenShare: (participantId: string) => Promise<V1CommandResult>;
  readonly removeParticipant: (participantId: string) => Promise<V1CommandResult>;
  readonly startRecording: () => Promise<{
    readonly recordingId: string;
    readonly result: V1CommandResult;
  }>;
  readonly stopRecording: (recordingId: string) => Promise<V1CommandResult>;
  readonly endEpisode: () => Promise<V1CommandResult>;
  readonly extendEpisode: (minutes: number) => Promise<V1CommandResult>;
  readonly onMediaPause?: (listener: (pause: V1MediaPause) => void) => () => void;
  readonly onDirectedRequest: (listener: (request: V1DirectedRequest) => void) => () => void;
  readonly requestUnmute: (participantId: string) => Promise<V1DirectedRequestResult>;
  readonly requestStartCamera: (participantId: string) => Promise<V1DirectedRequestResult>;
};
export type ConnectionMediaClient = ClientMediaPlane & {
  readonly start: (stream: MediaStream) => Promise<void>;
  readonly stop: () => void;
  readonly restart: (input: CloudflareSFUBootstrap | ParticipantMediaAccess) => Promise<void>;
  readonly prepareLocalTrack: (source: "microphone" | "camera" | "screen" | "screen_audio", track: MediaStreamTrack) => void;
  readonly clearPreparedLocalTrack: (source: "microphone" | "camera" | "screen" | "screen_audio", options?: { readonly stopTrack?: boolean }) => Promise<void>;
  readonly getSnapshot: () => ConnectionMediaSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};
export type ConnectionMediaFactoryInput = {
  readonly access: ParsedAccessGrant;
  readonly credential: () => Promise<string>;
  readonly replaceMediaConnection?: () => Promise<ParticipantMediaAccess>;
  readonly traceparent?: string;
  readonly onTransportDiagnostic?: (event: ConnectionReportTransportEvent) => void;
  readonly onFailure: (error: unknown, mediaConnectionId?: string) => void;
  readonly onScreenEnded: () => void;
};
export type ConnectionSyncFactoryInput = {
  readonly access: ParsedAccessGrant;
  readonly token: () => Promise<string>;
  readonly media: ConnectionMediaClient;
  readonly traceparent?: string;
  readonly onTransportDiagnostic?: (event: ConnectionReportTransportEvent) => void;
};
export type ConnectionWhiteboardFactoryInput = {
  readonly onWatchdogReplacement?: ChalkWhiteboardV1ClientOptions["onWatchdogReplacement"];
  readonly token: () => Promise<string>;
  readonly onSummary: (summary: ChalkWhiteboardSummary) => void;
};
export type ConnectionChatFileFactoryInput = {
  readonly token: () => Promise<string>;
};
export type ConnectionDependencies = {
  readonly clock: ConnectionClock;
  readonly createConnectionReporter?: (access: () => ParsedAccessGrant | null) => ConnectionReporter | undefined;
  readonly getEpisodeStatus?: (access: ParsedAccessGrant, signal: AbortSignal) => Promise<ParticipantEpisodeStatus["status"]>;
  readonly cancelPendingAdmission?: (access: ParsedAccessGrant, signal: AbortSignal) => Promise<boolean>;
  readonly mediaDevices: ConnectionMediaDevices;
  readonly createMediaClient: (input: ConnectionMediaFactoryInput) => ConnectionMediaClient;
  readonly createSyncClient: (input: ConnectionSyncFactoryInput) => ConnectionSyncClient;
  readonly createChatFileTransport?: (input: ConnectionChatFileFactoryInput) => ChalkChatFileTransport | null;
  readonly createWhiteboardClient?: (input: ConnectionWhiteboardFactoryInput) => ChalkWhiteboardV1Transport | null;
  readonly subscribeForeground?: (listener: () => void) => () => void;
  /**
   * Browser-only identifier creation lives in the platform adapter. Lifecycle
   * and feature code consume this seam so Effect tests can be deterministic.
   */
  readonly createId?: () => string;
};
/**
 * The foreign browser and transport boundary used by Connection. The Layer is
 * deliberately small: all scheduling and state ownership stays in Effect
 * programs above this adapter.
 */
export class ConnectionPlatformService extends Context.Service<ConnectionPlatformService, ConnectionDependencies>()("@chalk/client/ConnectionPlatform") {}
export const makeConnectionPlatformLayer = (dependencies: ConnectionDependencies) => Layer.succeed(ConnectionPlatformService, dependencies);
/** A named alias makes fake platform Layers self-documenting in tests. */
export const makeFakeConnectionPlatformLayer = makeConnectionPlatformLayer;
