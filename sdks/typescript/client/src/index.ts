export * from "./chat-files";
export * from "./media";
export * from "./collaboration";
export * from "./space-client";
export * from "./sync";
export * from "./whiteboard";
export * from "./public-invites";
export type { AppTelemetry } from "./telemetry/app";
export { TelemetryOutbox } from "./telemetry/outbox";
export { postTelemetry } from "./telemetry/send";
export type { DeliveryStep, PlatformChange, TelemetryJournal, TelemetryPlatform } from "./telemetry/types";
export { currentSessionId, lastFailedRequest, newSessionId, requestContextHeaders, SESSION_ID_KEY, sessionBaggage, setSessionSource, withRequestContext, type FailedRequest, type SessionSource } from "./session";

export { formatSyncConnectDiagnostic } from "./sync/connect-diagnostics";
export { getConnectionFailureDetail, getRecordingFailureDetail } from "./space-client/failure-detail";
export { mediaBootstrap } from "./access/media-bootstrap";

export { SDK_VERSION } from "./version";
export { ClassifiedError, expected, failure } from "./obs/kernel";
export type { Classification, Kernel } from "./obs/kernel";
export type { EventFields, SurfaceName } from "./obs/registry";
export { buildDiagnosticBundle, type DiagnosticBundleInput, type DiagnosticBundleState } from "./diagnostics/bundle";
export { uploadDiagnosticBundle, type DiagnosticUploadOptions, type DiagnosticUploadRequest, type DiagnosticUploadResult } from "./diagnostics/upload";
export { createLiveIntrospection, type LiveIntrospection } from "./diagnostics/live";
