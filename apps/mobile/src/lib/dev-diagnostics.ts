import type { WideEvent } from "@q9labs/chalk-core";

const isDevelopmentRuntime = typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production";

export interface DevDiagnosticsAuthInfo {
  userId: string;
  tenantId: string | null;
  roomId: string | null;
  displayName: string | null;
  role: string | null;
  scopes: string[];
  permissions: Record<string, boolean>;
  tokenIssuedAt: string;
  tokenExpiresAt: string;
  tokenExpiresInSeconds: number;
  serverTime: string;
  apiVersion: string;
  apiCommitSha: string;
  apiBuildTime: string;
  requestId: string;
  traceId: string;
}

export interface DevDiagnosticsRequestLog {
  id: string;
  timestamp: string;
  source: "wide-event" | "manual";
  eventType: string;
  method?: string;
  path?: string;
  url?: string;
  outcome: "success" | "error" | "timeout";
  statusCode?: number;
  durationMs?: number;
  requestId?: string | null;
  traceId?: string | null;
  cfRay?: string | null;
  errorMessage?: string;
}

interface DevDiagnosticsState {
  enabled: boolean;
  env: {
    buildProfile: string | null;
    apiUrl: string | null;
    wsUrl: string | null;
    target: "local" | "production" | "custom" | "unknown";
    routeKind: string | null;
    routeRoomId: string | null;
    routeSource: string | null;
  };
  auth: {
    hostMode: "configured-api-key" | "local-bootstrap" | "none" | null;
    configuredHostApiKeyPreview: string | null;
    localDevHostApiKeyPreview: string | null;
    joinTokenPreview: string | null;
    joinAccessTokenPreview: string | null;
    latestAccessTokenPreview: string | null;
    latestAccessTokenSource: string | null;
    authInfo: DevDiagnosticsAuthInfo | null;
  };
  requests: DevDiagnosticsRequestLog[];
}

const MAX_REQUEST_LOGS = 80;

const initialState = (): DevDiagnosticsState => ({
  enabled: isDevelopmentRuntime,
  env: {
    buildProfile: null,
    apiUrl: null,
    wsUrl: null,
    target: "unknown",
    routeKind: null,
    routeRoomId: null,
    routeSource: null,
  },
  auth: {
    hostMode: null,
    configuredHostApiKeyPreview: null,
    localDevHostApiKeyPreview: null,
    joinTokenPreview: null,
    joinAccessTokenPreview: null,
    latestAccessTokenPreview: null,
    latestAccessTokenSource: null,
    authInfo: null,
  },
  requests: [],
});

let state = initialState();
const listeners = new Set<() => void>();

const emitChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const updateState = (updater: (current: DevDiagnosticsState) => DevDiagnosticsState) => {
  if (!isDevelopmentRuntime) {
    return;
  }

  state = updater(state);
  emitChange();
};

const trimLogs = (logs: DevDiagnosticsRequestLog[]): DevDiagnosticsRequestLog[] => logs.slice(0, MAX_REQUEST_LOGS);

const normalizeHost = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

const isPrivate172Host = (host: string): boolean => {
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (!match || !match[1]) {
    return false;
  }

  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
};

export const maskSecret = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const classifyTarget = (apiUrl: string | null | undefined): DevDiagnosticsState["env"]["target"] => {
  const host = normalizeHost(apiUrl);
  if (!host) {
    return "unknown";
  }

  if (host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("10.") || host.startsWith("192.168.") || isPrivate172Host(host)) {
    return "local";
  }

  if (host === "chalk-api.q9labs.ai" || host === "chalk-ws.q9labs.ai") {
    return "production";
  }

  return "custom";
};

export const subscribeDevDiagnostics = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getDevDiagnosticsState = (): DevDiagnosticsState => state;

export const setDevDiagnosticsEnvironment = (next: Partial<DevDiagnosticsState["env"]>) => {
  updateState((current) => {
    const apiUrl = next.apiUrl ?? current.env.apiUrl;
    return {
      ...current,
      env: {
        ...current.env,
        ...next,
        apiUrl,
        target: classifyTarget(apiUrl),
      },
    };
  });
};

export const setDevDiagnosticsStaticAuth = (next: Partial<Omit<DevDiagnosticsState["auth"], "latestAccessTokenPreview" | "latestAccessTokenSource" | "authInfo">>) => {
  updateState((current) => ({
    ...current,
    auth: {
      ...current.auth,
      ...next,
    },
  }));
};

export const setDevDiagnosticsToken = (token: string, source: string) => {
  updateState((current) => ({
    ...current,
    auth: {
      ...current.auth,
      latestAccessTokenPreview: maskSecret(token),
      latestAccessTokenSource: source,
    },
  }));
};

export const setDevDiagnosticsAuthInfo = (authInfo: DevDiagnosticsAuthInfo | null) => {
  updateState((current) => ({
    ...current,
    auth: {
      ...current.auth,
      authInfo,
    },
  }));
};

export const clearDevDiagnosticsLogs = () => {
  updateState((current) => ({
    ...current,
    requests: [],
  }));
};

export const recordManualRequest = (entry: Omit<DevDiagnosticsRequestLog, "id" | "timestamp" | "source">) => {
  updateState((current) => ({
    ...current,
    requests: trimLogs([
      {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        source: "manual",
        ...entry,
      },
      ...current.requests,
    ]),
  }));
};

export const recordWideEvent = (event: WideEvent) => {
  const request = (event.data.request ?? {}) as { method?: string; path?: string };
  const response = (event.data.response ?? {}) as { statusCode?: number; requestId?: string | null; traceId?: string | null; cfRay?: string | null };

  updateState((current) => ({
    ...current,
    requests: trimLogs([
      {
        id: event.eventId,
        timestamp: event.timestamp,
        source: "wide-event",
        eventType: event.eventType,
        method: request.method,
        path: request.path,
        outcome: event.outcome,
        statusCode: response.statusCode,
        durationMs: event.durationMs,
        requestId: response.requestId,
        traceId: response.traceId,
        cfRay: response.cfRay,
        errorMessage: event.error?.message,
      },
      ...current.requests.filter((item) => item.id !== event.eventId),
    ]),
  }));
};

export const fetchDevDiagnosticsAuth = async (apiUrl: string, accessToken: string): Promise<DevDiagnosticsAuthInfo> => {
  const response = await fetch(`${apiUrl}/api/v1/debug/auth`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const responseMeta = {
    statusCode: response.status,
    requestId: response.headers?.get?.("x-request-id") ?? null,
    traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
    cfRay: response.headers?.get?.("cf-ray") ?? null,
  };
  const rawText = await response.text();

  if (!response.ok) {
    recordManualRequest({
      eventType: "api.request",
      method: "GET",
      path: "/api/v1/debug/auth",
      url: `${apiUrl}/api/v1/debug/auth`,
      outcome: "error",
      statusCode: responseMeta.statusCode,
      requestId: responseMeta.requestId,
      traceId: responseMeta.traceId,
      cfRay: responseMeta.cfRay,
      errorMessage: rawText || "Debug auth failed",
    });
    throw new Error(rawText || `Debug auth failed (${response.status})`);
  }

  const parsed = JSON.parse(rawText) as {
    user_id: string;
    tenant_id: string | null;
    room_id: string | null;
    display_name: string | null;
    role: string | null;
    scopes: string[];
    permissions: Record<string, boolean>;
    token_issued_at: string;
    token_expires_at: string;
    token_expires_in_seconds: number;
    server_time: string;
    api_version: string;
    api_commit_sha: string;
    api_build_time: string;
    request_id: string;
    trace_id: string;
  };

  recordManualRequest({
    eventType: "api.request",
    method: "GET",
    path: "/api/v1/debug/auth",
    url: `${apiUrl}/api/v1/debug/auth`,
    outcome: "success",
    statusCode: responseMeta.statusCode,
    requestId: responseMeta.requestId,
    traceId: responseMeta.traceId,
    cfRay: responseMeta.cfRay,
  });

  return {
    userId: parsed.user_id,
    tenantId: parsed.tenant_id,
    roomId: parsed.room_id,
    displayName: parsed.display_name,
    role: parsed.role,
    scopes: parsed.scopes,
    permissions: parsed.permissions,
    tokenIssuedAt: parsed.token_issued_at,
    tokenExpiresAt: parsed.token_expires_at,
    tokenExpiresInSeconds: parsed.token_expires_in_seconds,
    serverTime: parsed.server_time,
    apiVersion: parsed.api_version,
    apiCommitSha: parsed.api_commit_sha,
    apiBuildTime: parsed.api_build_time,
    requestId: parsed.request_id,
    traceId: parsed.trace_id,
  };
};

export const buildDevDiagnosticsCopyText = (): string =>
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      ...state,
    },
    null,
    2,
  );
