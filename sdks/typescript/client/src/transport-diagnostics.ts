import type { components } from "./generated/openapi-types";
export type ConnectionReport = components["schemas"]["ConnectionReportRequest"];
export type ConnectionReportTransportEvent = Pick<ConnectionReport["events"][number], "event" | "phase" | "attempt" | "duration_ms" | "heartbeat_gap_ms" | "close_code" | "http_status" | "source" | "publication_state" | "projection_state" | "outcome">;
