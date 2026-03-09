/**
 * Incident reporting primitives for Chalk SDK.
 */

export type ChalkIncidentSeverity = "error" | "warning" | "info";

export type ChalkIncidentSource = "session" | "video_conference" | "room" | "media" | "chat" | "recording" | "interactions" | "whiteboard" | "screen_share" | "websocket" | "api" | "unknown";

export interface ChalkIncidentBreadcrumb {
  timestamp: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ChalkIncidentConnectionContext {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

export interface ChalkIncidentContext {
  url?: string;
  userAgent?: string;
  online?: boolean;
  visibilityState?: string;
  connection?: ChalkIncidentConnectionContext;
}

export interface ChalkIncident {
  /** User-facing support/incident code. */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  severity: ChalkIncidentSeverity;
  source: ChalkIncidentSource;
  message: string;
  code?: string;
  roomId?: string | null;
  participantId?: string | null;
  traceId?: string;
  phase?: string;
  stage?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  breadcrumbs?: ChalkIncidentBreadcrumb[];
  context?: ChalkIncidentContext;
}

export interface ChalkIncidentInput {
  id?: string;
  severity?: ChalkIncidentSeverity;
  source?: ChalkIncidentSource;
  message: string;
  code?: string;
  phase?: string;
  stage?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  breadcrumbs?: ChalkIncidentBreadcrumb[];
  context?: ChalkIncidentContext;
}

export type IncidentReporter = ((incident: ChalkIncident) => Promise<void>) | ((incident: ChalkIncident) => void);

export interface ChalkIncidentConfig {
  /** Toggle incident emission. Defaults to true when handler/reporter exists. */
  enabled?: boolean;
  /** Local callback for custom handling (analytics/Sentry/etc). */
  onIncident?: (incident: ChalkIncident) => void;
  /** Optional transport to send incidents to backend endpoint. */
  reporter?: IncidentReporter;
  /** Keep last N breadcrumbs with each incident. */
  maxBreadcrumbs?: number;
}

export interface HttpIncidentReporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Use navigator.sendBeacon when page is hidden/unloading. */
  useBeacon?: boolean;
  /** Override fetch for tests/custom runtimes. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_HTTP_REPORTER_RETRIES = 2;
const DEFAULT_HTTP_REPORTER_RETRY_DELAY_MS = 250;
const DEFAULT_HTTP_REPORTER_TIMEOUT_MS = 5000;

const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
};

const canUseSendBeacon = (): boolean => typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && typeof document !== "undefined";

/**
 * Generate a support code with format: CHK-YYYYMMDD-HHMMSS-SEQ
 */
export const createSupportCode = (sequence: number, now: Date = new Date()): string => {
  const datePart = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0")].join("");
  const timePart = [String(now.getUTCHours()).padStart(2, "0"), String(now.getUTCMinutes()).padStart(2, "0"), String(now.getUTCSeconds()).padStart(2, "0")].join("");
  const seqPart = Math.max(1, sequence).toString(36).toUpperCase().padStart(3, "0");
  return `CHK-${datePart}-${timePart}-${seqPart}`;
};

/**
 * Capture browser diagnostics for incident payloads.
 */
export const createBrowserIncidentContext = (): ChalkIncidentContext => {
  if (typeof window === "undefined") return {};

  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  };

  return {
    url: `${window.location.origin}${window.location.pathname}`,
    userAgent: nav.userAgent,
    online: nav.onLine,
    visibilityState: typeof document !== "undefined" ? document.visibilityState : undefined,
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          downlink: nav.connection.downlink,
          rtt: nav.connection.rtt,
          saveData: nav.connection.saveData,
        }
      : undefined,
  };
};

/**
 * Built-in HTTP reporter for incidents.
 */
export const createHttpIncidentReporter = (config: HttpIncidentReporterConfig): IncidentReporter => {
  const retries = config.retries ?? DEFAULT_HTTP_REPORTER_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_HTTP_REPORTER_RETRY_DELAY_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_HTTP_REPORTER_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  return async (incident: ChalkIncident): Promise<void> => {
    const payload = {
      incident,
      reportedAt: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    if (config.useBeacon === true && canUseSendBeacon() && document.visibilityState === "hidden") {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(config.endpoint, blob);
      return;
    }

    if (!fetchImpl) {
      throw new Error("fetch is not available for HTTP incident reporting");
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const timeout = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

      try {
        const response = await fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.headers ?? {}),
          },
          body,
          signal: controller?.signal,
          keepalive: true,
        });

        if (!response.ok) {
          throw new Error(`incident reporter request failed: ${response.status} ${response.statusText}`);
        }

        return;
      } catch (error) {
        const isLastAttempt = attempt >= retries;
        if (isLastAttempt) {
          throw new Error(getErrorMessage(error));
        }
        const backoff = retryDelayMs * Math.pow(2, attempt);
        await waitMs(backoff);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };
};
