import type { NativeVideoConferenceDiagnosticsSnapshot } from "@q9labs/chalk-react-native";
import type { WideEvent, WideEventOutcome } from "@q9labs/chalk-core";

const isVitestRuntime = typeof process !== "undefined" && process.env.VITEST === "true";
const isDevelopmentRuntime = typeof __DEV__ !== "undefined" ? __DEV__ : isVitestRuntime || process.env.NODE_ENV !== "production";
const MAX_REQUEST_LOGS = 80;
const MAX_TIMELINE_ITEMS = 120;

export interface DevDiagnosticsTokenClaims {
  [key: string]: unknown;
}

export interface DevDiagnosticsTokenClaimsPreview {
  header: Record<string, unknown> | null;
  payload: DevDiagnosticsTokenClaims | null;
  error: string | null;
}

export interface DevDiagnosticsDeviceInfo {
  appVersion: string | null;
  platform: string | null;
  osVersion: string | null;
  reactNativeVersion: string | null;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  systemName: string | null;
  interfaceIdiom: string | null;
  hermesEnabled: boolean;
  scriptUrl: string | null;
}

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
  outcome: WideEventOutcome;
  statusCode?: number;
  durationMs?: number;
  requestId?: string | null;
  traceId?: string | null;
  cfRay?: string | null;
  errorMessage?: string;
}

export interface DevDiagnosticsTimelineEntry {
  id: string;
  timestamp: string;
  source: "wide-event" | "manual";
  eventType: string;
  outcome: WideEventOutcome;
  durationMs?: number;
  title: string;
  detail?: string;
  errorMessage?: string;
}

export interface DevDiagnosticsFailure {
  source: string;
  message: string;
  occurredAt: string;
}

export interface DevDiagnosticsState {
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
    hostMode: "configured-api-key" | "local-bootstrap" | "internal-bootstrap" | "none" | null;
    configuredHostApiKeyPreview: string | null;
    localDevHostApiKeyPreview: string | null;
    joinTokenPreview: string | null;
    joinAccessTokenPreview: string | null;
    latestAccessTokenPreview: string | null;
    latestAccessTokenSource: string | null;
    joinTokenClaims: DevDiagnosticsTokenClaimsPreview | null;
    joinAccessTokenClaims: DevDiagnosticsTokenClaimsPreview | null;
    latestAccessTokenClaims: DevDiagnosticsTokenClaimsPreview | null;
    authInfo: DevDiagnosticsAuthInfo | null;
  };
  device: DevDiagnosticsDeviceInfo | null;
  session: NativeVideoConferenceDiagnosticsSnapshot | null;
  lastFailure: DevDiagnosticsFailure | null;
  requests: DevDiagnosticsRequestLog[];
  timeline: DevDiagnosticsTimelineEntry[];
}

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
    joinTokenClaims: null,
    joinAccessTokenClaims: null,
    latestAccessTokenClaims: null,
    authInfo: null,
  },
  device: null,
  session: null,
  lastFailure: null,
  requests: [],
  timeline: [],
});

let state = initialState();
const listeners = new Set<() => void>();
let emitQueued = false;

const emitChange = () => {
  if (emitQueued) {
    return;
  }

  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    for (const listener of listeners) {
      listener();
    }
  });
};

const updateState = (updater: (current: DevDiagnosticsState) => DevDiagnosticsState) => {
  if (!isDevelopmentRuntime) {
    return;
  }

  state = updater(state);
  emitChange();
};

const trimLogs = <T>(logs: T[], limit: number): T[] => logs.slice(0, limit);

const sanitizeForJson = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForJson(entry, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => [key, sanitizeForJson(entryValue, seen)] as const)
      .filter(([, entryValue]) => entryValue !== undefined);

    return Object.fromEntries(entries);
  }

  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(sanitizeForJson(value)) ?? "null";

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

const createId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeJsonPreview = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(normalizeJsonPreview);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, entryValue]) => [key, normalizeJsonPreview(entryValue)]),
    );
  }

  if (typeof value === "string" && value.length > 300) {
    return `${value.slice(0, 297)}...`;
  }

  return value;
};

const parseBase64UrlJson = (raw: string): Record<string, unknown> | null => {
  try {
    const normalized = raw
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const decoded = typeof globalThis.atob === "function" ? globalThis.atob(normalized) : typeof Buffer !== "undefined" ? Buffer.from(normalized, "base64").toString("utf-8") : null;
    if (!decoded) {
      return null;
    }

    return normalizeJsonPreview(JSON.parse(decoded)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const formatTimelineTitle = (eventType: string, outcome: WideEventOutcome): string => {
  const label = eventType.replace(/\./g, " ").toUpperCase();
  return `${label} ${outcome.toUpperCase()}`;
};

const formatTimelineDetail = (eventType: string, data: Record<string, unknown>, request?: { method?: string; path?: string }, response?: { statusCode?: number | null }): string => {
  switch (eventType) {
    case "api.request":
      return [request?.method, request?.path, response?.statusCode ? `status ${response.statusCode}` : null].filter(Boolean).join(" ");
    case "room.join.rtk.attempt":
      return `attempt ${String(data.attempt ?? "?")}/${String(data.totalAttempts ?? "?")} timeout ${String(data.timeoutMs ?? "?")}ms`;
    case "chat.send":
      return [data.transport ? `transport ${String(data.transport)}` : null, `chars ${String(data.contentLength ?? 0)}`, `attachments ${String(data.attachmentCount ?? 0)}`, data.wsConnectionState ? `ws ${String(data.wsConnectionState)}` : null, data.localOnly ? "local only" : null]
        .filter(Boolean)
        .join(" ");
    case "chat.message.receive":
      return [`from ${String(data.participantName ?? data.participantId ?? "unknown")}`, `chars ${String(data.contentLength ?? 0)}`, `attachments ${String(data.attachmentCount ?? 0)}`].filter(Boolean).join(" ");
    case "chat.read.receive":
      return [`participant ${String(data.participantId ?? "")}`.trim(), `messages ${String(data.messageCount ?? 0)}`].filter(Boolean).join(" ");
    case "media.toggle":
      return [
        `${String(data.mediaType ?? "media")} ${String(data.before ?? "?")} -> ${String(data.enabled ?? "?")}`,
        `track ${String(data.hasTrack ?? false)}`,
        data.trackReadyState ? `ready ${String(data.trackReadyState)}` : null,
        typeof data.trackMuted === "boolean" ? `muted ${String(data.trackMuted)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "media.video.update":
    case "media.audio.update":
      return [
        data.scope ? `scope ${String(data.scope)}` : null,
        data.participantName ? `name ${String(data.participantName)}` : null,
        data.participantId ? `participant ${String(data.participantId)}` : null,
        `enabled ${String(data.enabled ?? "?")}`,
        `track ${String(data.hasTrack ?? false)}`,
        data.trackReadyState ? `ready ${String(data.trackReadyState)}` : null,
        typeof data.trackMuted === "boolean" ? `muted ${String(data.trackMuted)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "screenshare.start":
      return [
        `withAudio ${String(data.withAudio ?? false)}`,
        `participant ${String(data.participantId ?? "")}`.trim(),
        `videoTrack ${String(data.hasVideoTrack ?? false)}`,
        `audioTrack ${String(data.hasAudioTrack ?? false)}`,
        data.videoTrackReadyState ? `videoReady ${String(data.videoTrackReadyState)}` : null,
        data.audioTrackReadyState ? `audioReady ${String(data.audioTrackReadyState)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "screenshare.stop":
      return [`participant ${String(data.participantId ?? "")}`.trim(), `videoTrack ${String(data.hasVideoTrack ?? false)}`, `audioTrack ${String(data.hasAudioTrack ?? false)}`].filter(Boolean).join(" ");
    case "screenshare.update":
      return [
        data.scope ? `scope ${String(data.scope)}` : null,
        data.participantName ? `name ${String(data.participantName)}` : null,
        data.participantId ? `participant ${String(data.participantId)}` : null,
        `enabled ${String(data.enabled ?? "?")}`,
        `videoTrack ${String(data.hasVideoTrack ?? false)}`,
        `audioTrack ${String(data.hasAudioTrack ?? false)}`,
        data.videoTrackReadyState ? `videoReady ${String(data.videoTrackReadyState)}` : null,
        data.audioTrackReadyState ? `audioReady ${String(data.audioTrackReadyState)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "reaction.send":
      return `emoji ${String(data.emoji ?? "")}`.trim();
    case "reaction.receive":
      return `${String(data.emoji ?? "")} from ${String(data.participantName ?? data.participantId ?? "unknown")}`.trim();
    case "hand.raise":
    case "hand.lower":
      return [data.direction ? `direction ${String(data.direction)}` : null, data.participantId ? `participant ${String(data.participantId)}` : null].filter(Boolean).join(" ");
    case "participant.mute.request":
    case "participant.unmute.request":
    case "participant.mute.receive":
    case "participant.unmute.receive":
      return `participant ${String(data.participantId ?? "")}`.trim();
    case "participant.moderation.audio":
      return `${String(data.action ?? "audio")} enabled ${String(data.enabled ?? "?")}`;
    case "websocket.connect":
      return [`room ${String(data.roomId ?? "")}`.trim(), `attempt ${String(data.attempt ?? 1)}`.trim()].filter(Boolean).join(" ");
    case "websocket.disconnect":
      return [`reason ${String(data.reason ?? "unknown")}`.trim(), data.closeCode ? `code ${String(data.closeCode)}` : null, data.closeReason ? `close ${String(data.closeReason)}` : null, typeof data.wasClean === "boolean" ? `clean ${String(data.wasClean)}` : null].filter(Boolean).join(" ");
    case "websocket.reconnect":
      return [`attempt ${String(data.attempt ?? "?")}`.trim(), data.delayMs ? `delay ${String(data.delayMs)}ms` : null, data.trigger ? `trigger ${String(data.trigger)}` : null].filter(Boolean).join(" ");
    case "websocket.error":
      return [data.stage ? `stage ${String(data.stage)}` : null, data.messageType ? `message ${String(data.messageType)}` : null, data.readyStateDesc ? `state ${String(data.readyStateDesc)}` : null].filter(Boolean).join(" ");
    case "room.join":
      return `room ${String(data.roomId ?? "")}`.trim();
    case "room.leave":
      return `room ${String(data.roomId ?? "")}`.trim();
    default:
      return JSON.stringify(normalizeJsonPreview(data));
  }
};

const appendTimeline = (current: DevDiagnosticsState, entry: DevDiagnosticsTimelineEntry): DevDiagnosticsState => ({
  ...current,
  timeline: trimLogs([entry, ...current.timeline.filter((item) => item.id !== entry.id)], MAX_TIMELINE_ITEMS),
});

export const maskSecret = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const decodeTokenClaimsPreview = (token: string | null | undefined): DevDiagnosticsTokenClaimsPreview | null => {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return null;
  }

  const header = parseBase64UrlJson(parts[0]);
  const payload = parseBase64UrlJson(parts[1]);
  if (!header || !payload) {
    return {
      header: null,
      payload: null,
      error: "Unable to decode JWT payload",
    };
  }

  return {
    header,
    payload,
    error: null,
  };
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

export const resolveDevDiagnosticsMode = ({ isDevRuntime, apiUrl }: { isDevRuntime: boolean; apiUrl: string | null | undefined }) => ({
  enabled: isDevRuntime,
  buildProfile: isDevRuntime ? "development" : "production",
  target: classifyTarget(apiUrl),
});

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
    const env = {
      ...current.env,
      ...next,
      apiUrl,
      target: classifyTarget(apiUrl),
    };

    if (stableJson(env) === stableJson(current.env)) {
      return current;
    }

    return {
      ...current,
      env,
    };
  });
};

export const setDevDiagnosticsStaticAuth = (
  next: Partial<Pick<DevDiagnosticsState["auth"], "hostMode" | "configuredHostApiKeyPreview" | "localDevHostApiKeyPreview" | "joinTokenPreview" | "joinAccessTokenPreview" | "joinTokenClaims" | "joinAccessTokenClaims">> & { device?: DevDiagnosticsDeviceInfo | null },
) => {
  updateState((current) => ({
    ...current,
    device: next.device ?? current.device,
    auth: {
      ...current.auth,
      hostMode: next.hostMode ?? current.auth.hostMode,
      configuredHostApiKeyPreview: next.configuredHostApiKeyPreview ?? current.auth.configuredHostApiKeyPreview,
      localDevHostApiKeyPreview: next.localDevHostApiKeyPreview ?? current.auth.localDevHostApiKeyPreview,
      joinTokenPreview: next.joinTokenPreview ?? current.auth.joinTokenPreview,
      joinAccessTokenPreview: next.joinAccessTokenPreview ?? current.auth.joinAccessTokenPreview,
      joinTokenClaims: next.joinTokenClaims ?? current.auth.joinTokenClaims,
      joinAccessTokenClaims: next.joinAccessTokenClaims ?? current.auth.joinAccessTokenClaims,
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
      latestAccessTokenClaims: decodeTokenClaimsPreview(token),
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

export const setDevDiagnosticsSession = (snapshot: NativeVideoConferenceDiagnosticsSnapshot | null) => {
  updateState((current) => {
    if (stableJson(current.session) === stableJson(snapshot)) {
      return current;
    }

    const previousReason = current.session?.meetingRoom?.actionAvailability.screenShare.reason ?? null;
    const nextReason = snapshot?.meetingRoom?.actionAvailability.screenShare.reason ?? null;
    const nextDetail = snapshot?.meetingRoom?.actionAvailability.screenShare.detail ?? null;
    const nextState = {
      ...current,
      session: snapshot,
    };

    if (previousReason === nextReason && current.session?.meetingRoom?.actionAvailability.screenShare.detail === nextDetail) {
      return nextState;
    }

    return appendTimeline(nextState, {
      id: createId("screenshare-availability"),
      timestamp: new Date().toISOString(),
      source: "manual",
      eventType: "meeting_room.screenshare_availability",
      outcome: nextReason ? "error" : "success",
      title: "SCREEN SHARE AVAILABILITY",
      detail: nextReason ? `${nextReason}${nextDetail ? ` · ${nextDetail}` : ""}` : "screen share available",
    });
  });
};

export const clearDevDiagnosticsLogs = () => {
  updateState((current) => ({
    ...current,
    requests: [],
    timeline: [],
  }));
};

export const resetDevDiagnosticsState = () => {
  updateState((current) => ({
    ...initialState(),
    enabled: current.enabled,
    env: current.env,
    device: current.device,
  }));
};

export const recordDiagnosticsFailure = (source: string, message: string) => {
  updateState((current) =>
    appendTimeline(
      {
        ...current,
        lastFailure: {
          source,
          message,
          occurredAt: new Date().toISOString(),
        },
      },
      {
        id: createId("failure"),
        timestamp: new Date().toISOString(),
        source: "manual",
        eventType: "diagnostics.failure",
        outcome: "error",
        title: "DIAGNOSTICS FAILURE",
        detail: `${source}: ${message}`,
        errorMessage: message,
      },
    ),
  );
};

export const recordDevDiagnosticsLifecycleEvent = (eventType: string, title: string, detail?: string) => {
  updateState((current) =>
    appendTimeline(current, {
      id: createId("lifecycle"),
      timestamp: new Date().toISOString(),
      source: "manual",
      eventType,
      outcome: "success",
      title,
      detail,
    }),
  );
};

export const recordManualRequest = (entry: Omit<DevDiagnosticsRequestLog, "id" | "timestamp" | "source">) => {
  updateState((current) => {
    const timestamp = new Date().toISOString();
    const id = createId("manual");

    return appendTimeline(
      {
        ...current,
        requests: trimLogs(
          [
            {
              id,
              timestamp,
              source: "manual",
              ...entry,
            },
            ...current.requests,
          ],
          MAX_REQUEST_LOGS,
        ),
      },
      {
        id,
        timestamp,
        source: "manual",
        eventType: entry.eventType,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
        title: formatTimelineTitle(entry.eventType, entry.outcome),
        detail: [entry.method, entry.path ?? entry.url, entry.statusCode ? `status ${entry.statusCode}` : null].filter(Boolean).join(" "),
        errorMessage: entry.errorMessage,
      },
    );
  });
};

export const recordWideEvent = (event: WideEvent) => {
  const request = (event.data.request ?? {}) as { method?: string; path?: string };
  const response = (event.data.response ?? {}) as { statusCode?: number | null; requestId?: string | null; traceId?: string | null; cfRay?: string | null };

  updateState((current) => {
    const nextState = appendTimeline(current, {
      id: event.eventId,
      timestamp: event.timestamp,
      source: "wide-event",
      eventType: event.eventType,
      outcome: event.outcome,
      durationMs: event.durationMs,
      title: formatTimelineTitle(event.eventType, event.outcome),
      detail: formatTimelineDetail(event.eventType, event.data, request, response),
      errorMessage: event.error?.message,
    });

    if (event.eventType !== "api.request") {
      return nextState;
    }

    return {
      ...nextState,
      requests: trimLogs(
        [
          {
            id: event.eventId,
            timestamp: event.timestamp,
            source: "wide-event",
            eventType: event.eventType,
            method: request.method,
            path: request.path,
            outcome: event.outcome,
            statusCode: response.statusCode ?? undefined,
            durationMs: event.durationMs,
            requestId: response.requestId,
            traceId: response.traceId,
            cfRay: response.cfRay,
            errorMessage: event.error?.message,
          },
          ...nextState.requests.filter((item) => item.id !== event.eventId),
        ],
        MAX_REQUEST_LOGS,
      ),
    };
  });
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
    sanitizeForJson({
      generatedAt: new Date().toISOString(),
      ...state,
    }),
    null,
    2,
  ) ?? "null";
