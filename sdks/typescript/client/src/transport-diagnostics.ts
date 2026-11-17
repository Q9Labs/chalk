import type { TelemetryEvent } from "./telemetry/types";

/** What a transport says about itself. The telemetry outbox sends it as an event of type `event`. */
export type TransportDiagnostic = Pick<
  TelemetryEvent,
  | "code"
  | "media_error_kind"
  | "media_error_step"
  | "phase"
  | "attempt"
  | "mechanism"
  | "outage_ms"
  | "duration_ms"
  | "heartbeat_gap_ms"
  | "close_code"
  | "http_status"
  | "source"
  | "publication_state"
  | "projection_state"
  | "outcome"
  | "receive_state"
  | "track_state"
  | "element_state"
  | "play_result"
  | "receive_counts"
  | "receivers_stopped"
  | "bundle_tag_held"
  | "upload_failure"
> & { readonly event: TelemetryEvent["type"] };
