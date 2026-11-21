import type { ParsedAccessGrant } from "../access/grant";
import type { TelemetryOutbox } from "../telemetry/outbox";
import type { V1EpisodeSnapshot } from "../sync/v1-types";
import { buildDiagnosticBundle, type DiagnosticBundleState } from "./bundle";
import { uploadDiagnosticBundle } from "./upload";

/** A request the server framed for this participant, answered with one ack on the wire and one diagnostic upload. */
export type LiveRequestFrame = { readonly requestId: string; readonly expiresAtMs: number };
export type LiveIntrospection = (request: LiveRequestFrame) => void;

const lastErrorCode = (connection: V1EpisodeSnapshot["connection"] | undefined): string | undefined => {
  if (!connection) return undefined;
  if (connection.phase === "terminal") return connection.terminalReason ?? "terminal";
  if (connection.connectFailure) return `sync_connect_${connection.connectFailure.stage}_${connection.connectFailure.closeCode ?? "unknown"}`;
  return undefined;
};

/**
 * The client-side answer to `live_request`: build the named-state bundle and run the upload lifecycle.
 * Never throws — the op records the outcome on `report.upload`.
 */
export function createLiveIntrospection(options: {
  readonly apiBaseURL: string;
  readonly access: ParsedAccessGrant;
  readonly telemetry: TelemetryOutbox;
  /** Reads the live connection snapshot at request time; the sync client may still be under construction when this factory runs. */
  readonly connection: () => V1EpisodeSnapshot["connection"] | undefined;
  readonly isHidden?: () => boolean;
  readonly fetch?: typeof globalThis.fetch;
}): LiveIntrospection {
  return (request) => {
    const connection = options.connection();
    const state: DiagnosticBundleState = {
      connection_status: connection?.phase ?? "unavailable(no_snapshot)",
      client_session_id: options.telemetry.clientSessionId,
      participant_id: options.access.subject.participantId,
      episode_id: options.access.subject.episodeId,
      sdk_version: options.telemetry.buildInfo.sdk_version ?? "unavailable(no_build)",
      ...(lastErrorCode(connection) ? { last_error_code: lastErrorCode(connection) } : {}),
      ...(options.telemetry.buildInfo.app_version ? { app_version: options.telemetry.buildInfo.app_version } : {}),
      ...(options.telemetry.obs.flagsHash() ? { flags_hash: options.telemetry.obs.flagsHash()! } : {}),
    };
    void uploadDiagnosticBundle({
      apiBaseURL: options.apiBaseURL,
      tenantId: options.access.subject.tenantId,
      credential: options.access.media.token,
      request: { trigger: "live", liveRequestId: request.requestId },
      bundle: () => buildDiagnosticBundle({ state }),
      obs: options.telemetry.obs,
      ...(options.isHidden ? { isHidden: options.isHidden } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }).catch(() => undefined);
  };
}
