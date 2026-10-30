import type { components } from "./generated/openapi-types";
export type ConnectionReport = components["schemas"]["ConnectionReportRequest"];
export type ConnectionReportTransportEvent = Pick<
  ConnectionReport["events"][number],
  "code" | "media_error_kind" | "media_error_step" | "event" | "phase" | "attempt" | "duration_ms" | "heartbeat_gap_ms" | "close_code" | "http_status" | "source" | "publication_state" | "projection_state" | "outcome"
>;
