import type { ChalkIncident, ChalkIncidentBreadcrumb } from "../incident.ts";
import type { WideEvent } from "../wide-events/index.ts";

export interface ChalkDebugFetchRecord {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  credentials?: string;
  mode?: string;
  destination?: string;
  referrer?: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  redirected?: boolean;
  durationMs?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  error?: string;
}

export interface ChalkDebugWebSocketRecord {
  id: string;
  timestamp: string;
  url: string;
  event: "construct" | "open" | "message" | "send" | "close" | "error";
  readyState?: number;
  protocols?: string[];
  payload?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  error?: string;
}

export interface ChalkDebugConsoleRecord {
  id: string;
  timestamp: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  args: unknown[];
}

export interface ChalkDebugRuntimeErrorRecord {
  id: string;
  timestamp: string;
  type: "error" | "unhandledrejection";
  message?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  reason?: unknown;
}

export interface ChalkDebugSnapshot {
  generatedAt: string;
  fetch: ChalkDebugFetchRecord[];
  websocket: ChalkDebugWebSocketRecord[];
  console: ChalkDebugConsoleRecord[];
  runtimeErrors: ChalkDebugRuntimeErrorRecord[];
  wideEvents: WideEvent[];
  incidents: ChalkIncident[];
  breadcrumbs: ChalkIncidentBreadcrumb[];
  sections: Record<string, unknown>;
}
