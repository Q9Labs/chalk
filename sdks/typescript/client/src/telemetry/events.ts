import type { ReportedConnectionDiagnostic } from "../connection/diagnostics";
import type { TransportDiagnostic } from "../transport-diagnostics";
import type { TelemetryDraft } from "./types";

const MAX_MS = 2_147_483_647;
const MAX_COUNT = 10_000;

const whole = (value: number, max = MAX_MS): number => Math.max(0, Math.min(max, Math.round(Number.isFinite(value) ? value : 0)));
const optionalWhole = (value: number | null | undefined): number | undefined => (value == null ? undefined : whole(value));

/** A connection observer's diagnostic, as the wire event. Only closed enums and numbers cross: no message, token, address or label. */
export function diagnosticEvent(diagnostic: ReportedConnectionDiagnostic): TelemetryDraft {
  const { media } = diagnostic;
  return {
    type: diagnostic.event,
    state: diagnostic.state,
    step: diagnostic.step,
    outcome: diagnostic.outcome,
    code: diagnostic.code,
    mechanism: diagnostic.mechanism,
    attempt: optionalWhole(diagnostic.attempt),
    duration_ms: optionalWhole(diagnostic.sync?.durationMs ?? diagnostic.durationMs),
    outage_ms: optionalWhole(diagnostic.outageMs),
    close_code: diagnostic.sync?.closeCode ?? undefined,
    heartbeat_gap_ms: optionalWhole(diagnostic.recovery?.lastHeartbeatReplyAgoMs),
    media_error_kind: media?.media_error_kind,
    media_error_step: media?.media_error_step,
    granted_audio: media?.granted_audio,
    granted_video: media?.granted_video,
    http_status: media?.http_status,
  };
}

/** A transport's diagnostic, as the wire event. */
export function transportEvent(event: TransportDiagnostic): TelemetryDraft {
  const { event: type, receive_counts, receivers_stopped, attempt, duration_ms, heartbeat_gap_ms, ...rest } = event;
  return {
    ...rest,
    type,
    attempt: optionalWhole(attempt),
    duration_ms: optionalWhole(duration_ms),
    heartbeat_gap_ms: optionalWhole(heartbeat_gap_ms),
    receivers_stopped: receivers_stopped == null ? undefined : whole(receivers_stopped, MAX_COUNT),
    receive_counts: receive_counts ? countsOf(receive_counts) : undefined,
  };
}

function countsOf(counts: NonNullable<TransportDiagnostic["receive_counts"]>): NonNullable<TransportDiagnostic["receive_counts"]> {
  const bounded: NonNullable<TransportDiagnostic["receive_counts"]> = {};
  for (const key of ["announced", "pull_requested", "pull_failed", "pull_succeeded", "track_received", "bytes_flowing", "element_bound", "playing", "projection_off"] as const) {
    const value = counts[key];
    if (value != null) bounded[key] = whole(value, MAX_COUNT);
  }
  return bounded;
}
