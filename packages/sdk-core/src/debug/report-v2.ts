import type { ChalkDebugFetchRecord, ChalkDebugSnapshot } from "./types.ts";

type DebugReportAppMeta = {
  name: string;
  sdkReactVersion?: string | null;
  sdkCoreVersion?: string | null;
  consumerAppName?: string | null;
  consumerAppVersion?: string | null;
  commitHash?: string | null;
  buildTime?: string | null;
};

type DebugReportBrowser = {
  navigator: unknown;
  permissions: unknown;
  devices: unknown;
  storage: {
    localStorage: Record<string, string | null>;
    sessionStorage: Record<string, string | null>;
  };
  document: Record<string, unknown>;
};

export type BuildStructuredDebugReportInput = {
  generatedAt: string;
  reportType: string;
  app: DebugReportAppMeta;
  location: {
    url: string;
    origin: string;
    host: string;
    pathname: string;
    search: string;
    hash: string;
    title?: string | null;
    referrer?: string | null;
    historyLength?: number | null;
    visibilityState?: string | null;
  };
  browser: DebugReportBrowser;
  logs: ChalkDebugSnapshot;
  context?: Record<string, unknown>;
  environment?: {
    apiUrl?: string | null;
    wsUrl?: string | null;
    env?: Record<string, unknown> | null;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEYS = new Set(["authorization", "access_token", "refresh_token", "cookie", "set-cookie", "x-api-key"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record).map(([key, currentValue]) => {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        return [key, "[REDACTED]"];
      }
      return [key, redact(currentValue)];
    }),
  );
};

const parseCookieNames = (cookieValue: unknown) => {
  if (typeof cookieValue !== "string" || cookieValue.trim() === "") return [];
  return cookieValue
    .split(";")
    .map((part) => part.trim().split("=")[0]?.trim())
    .filter((value): value is string => Boolean(value));
};

const decodeJwtClaims = (token: string) => {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) return null;

  try {
    const payload = payloadPart
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    const json =
      typeof atob === "function"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("utf8");
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
};

const tokenSummary = (token: string, source: string, url: string) => {
  const claims = decodeJwtClaims(token);
  const exp =
    typeof claims?.exp === "number"
      ? new Date(claims.exp * 1000).toISOString()
      : null;

  return {
    source,
    url,
    issuer: typeof claims?.iss === "string" ? claims.iss : null,
    subject: typeof claims?.sub === "string" ? claims.sub : null,
    tenantId: typeof claims?.tenant_id === "string" ? claims.tenant_id : null,
    workspaceId: typeof claims?.workspace_id === "string" ? claims.workspace_id : null,
    roomIdClaim: typeof claims?.room_id === "string" ? claims.room_id : null,
    role: typeof claims?.role === "string" ? claims.role : null,
    expiresAt: exp,
  };
};

const collectTokenSummaries = (fetchRecords: ChalkDebugFetchRecord[]) =>
  fetchRecords.flatMap((record) => {
    const candidates: Array<ReturnType<typeof tokenSummary>> = [];
    const authHeader = record.requestHeaders?.authorization ?? record.requestHeaders?.Authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      candidates.push(tokenSummary(authHeader.slice("Bearer ".length), "request-bearer", record.url));
    }

    const responseBody = asRecord(record.responseBody);
    const accessToken =
      typeof responseBody?.access_token === "string"
        ? responseBody.access_token
        : typeof responseBody?.accessToken === "string"
          ? responseBody.accessToken
          : null;
    if (accessToken) {
      const source = record.url.includes("/internal/auth/access-token")
        ? "internal-access-token"
        : record.url.includes("/join-token/exchange")
          ? "join-token-exchange"
          : "response-access-token";
      candidates.push(tokenSummary(accessToken, source, record.url));
    }

    return candidates;
  });

const sanitizeFetchRecords = (fetchRecords: ChalkDebugFetchRecord[]) =>
  fetchRecords.map((record) => ({
    ...record,
    requestHeaders: record.requestHeaders ? (redact(record.requestHeaders) as Record<string, string>) : record.requestHeaders,
    responseHeaders: record.responseHeaders ? (redact(record.responseHeaders) as Record<string, string>) : record.responseHeaders,
    requestBody: redact(record.requestBody),
    responseBody: redact(record.responseBody),
  }));

const getRouteTarget = (pathname: string) => {
  if (pathname.startsWith("/room/")) {
    return {
      targetType: "roomId",
      rawTarget: decodeURIComponent(pathname.slice("/room/".length)),
      source: "route-param",
      entryPoint: "direct-room-url",
    } as const;
  }
  if (pathname.startsWith("/j/")) {
    return {
      targetType: "joinToken",
      rawTarget: decodeURIComponent(pathname.slice("/j/".length)),
      source: "route-param",
      entryPoint: "join-link",
    } as const;
  }
  return {
    targetType: "unknown",
    rawTarget: null,
    source: "unknown",
    entryPoint: "unknown",
  } as const;
};

const deriveApiUrl = (snapshot: ChalkDebugSnapshot) => {
  const sessionInit = snapshot.wideEvents.find((event) => event.eventType === "session.init");
  const config = asRecord(sessionInit?.data?.config);
  return typeof config?.apiUrl === "string" ? config.apiUrl : null;
};

const compactTimeline = (snapshot: ChalkDebugSnapshot) =>
  [
    ...snapshot.fetch
      .filter((record) => !record.ok || record.url.includes("/api/v1/rooms/"))
      .map((record) => ({
        timestamp: record.timestamp,
        kind: "http",
        label: `${record.method} ${record.ok ? "ok" : "failed"}`,
        data: {
          method: record.method,
          path: record.url.replace(/^https?:\/\/[^/]+/, ""),
          status: record.status ?? null,
          error: record.error ?? null,
        },
      })),
    ...snapshot.wideEvents
      .filter((event) => ["ui.join.click", "ui.join.phase_transition", "room.join"].includes(event.eventType))
      .map((event) => ({
        timestamp: event.timestamp,
        kind: event.eventType.startsWith("ui.") ? "ui" : "sdk",
        label: event.eventType,
        data: redact(event.data),
      })),
  ]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(0, 25);

export const buildStructuredDebugReport = ({
  generatedAt,
  reportType,
  app,
  location,
  browser,
  logs,
  context = {},
  environment,
}: BuildStructuredDebugReportInput) => {
  const contextualTarget =
    typeof context.roomId === "string"
      ? { targetType: "roomId", rawTarget: context.roomId, source: "consumer-context", entryPoint: "consumer-app" }
      : typeof context.joinToken === "string"
        ? { targetType: "joinToken", rawTarget: context.joinToken, source: "consumer-context", entryPoint: "consumer-app" }
        : typeof context.inviteLink === "string"
          ? { targetType: "inviteLink", rawTarget: context.inviteLink, source: "consumer-context", entryPoint: "consumer-app" }
          : null;
  const routeTarget = (() => {
    const fromRoute = getRouteTarget(location.pathname);
    return fromRoute.targetType === "unknown" && contextualTarget ? contextualTarget : fromRoute;
  })();
  const sanitizedFetch = sanitizeFetchRecords(logs.fetch);
  const tokenSummaries = collectTokenSummaries(logs.fetch);
  const activeToken =
    [...tokenSummaries]
      .reverse()
      .find((summary) => summary.tenantId || summary.workspaceId || summary.roomIdClaim || summary.subject) ??
    tokenSummaries.at(-1) ??
    null;
  const failingFetch = logs.fetch.find((record) => !record.ok);
  const firstRoomLookup = logs.fetch.find((record) => record.url.includes("/api/v1/rooms/") && record.method === "GET");
  const joinPost = logs.fetch.find((record) => record.url.includes("/api/v1/rooms/") && record.method === "POST" && record.url.includes("/participants"));
  const latestIncident = logs.incidents.at(-1) ?? null;
  const latestWideError = [...logs.wideEvents].reverse().find((event) => event.outcome === "error") ?? null;
  const roomIdLooksMutated = typeof routeTarget.rawTarget === "string" && routeTarget.rawTarget.includes("roomName=");
  const roomIdFormatValid = routeTarget.targetType !== "roomId" ? null : UUID_RE.test(routeTarget.rawTarget ?? "");
  const backendRoomLookupFailedBeforeJoin = firstRoomLookup?.status === 404;
  const joinAttemptReachedRtc = logs.wideEvents.some((event) => event.eventType.startsWith("room.join.rtk.") && event.outcome === "success");
  const joinAttemptReachedWebsocket = logs.websocket.some((record) => record.event === "open");
  const tokenTenantMismatchSuspected =
    Boolean(activeToken?.tenantId) &&
    Boolean(firstRoomLookup?.status === 404 || joinPost?.status === 404);
  const failureClass = roomIdLooksMutated
    ? "room_identifier_mutation"
    : backendRoomLookupFailedBeforeJoin
      ? "room_resolution"
      : joinPost?.status === 404
        ? "room_join"
        : "unknown";

  const headline =
    failureClass === "room_identifier_mutation"
      ? "Malformed room identifier reached the join pipeline"
      : failureClass === "room_resolution"
        ? "Room lookup failed before join"
        : failureClass === "room_join"
          ? "Participant join failed after room targeting"
          : "Debug report captured an unknown failure";

  return {
    meta: {
      schemaVersion: "chalk-debug-report/v2",
      generatedAt,
      reportType,
      app,
    },
    summary: {
      headline,
      failureClass,
      severity: latestIncident?.severity ?? "error",
      supportCode: (typeof context.supportCode === "string" ? context.supportCode : latestIncident?.id) ?? null,
      primaryError: {
        message: (typeof context.error === "string" ? context.error : latestIncident?.message ?? latestWideError?.error?.message) ?? null,
        code: latestIncident?.code ?? latestWideError?.error?.code ?? null,
      },
      phase: latestIncident?.phase ?? (typeof context.phase === "string" ? context.phase : null),
      firstFailingOperation: failingFetch
        ? {
            kind: "http",
            method: failingFetch.method,
            path: failingFetch.url.replace(/^https?:\/\/[^/]+/, ""),
            status: failingFetch.status ?? null,
          }
        : null,
      derived: {
        roomIdFormatValid,
        roomIdLooksMutated,
        backendRoomLookupFailedBeforeJoin,
        joinAttemptReachedRtc,
        joinAttemptReachedWebsocket,
        tokenTenantMismatchSuspected,
        wrongEnvironmentSuspected: false,
      },
    },
    joinContext: {
      targetType: routeTarget.targetType,
      rawTarget: routeTarget.rawTarget,
      canonicalTarget:
        typeof context.canonicalRoomId === "string"
          ? context.canonicalRoomId
          : routeTarget.rawTarget,
      source: routeTarget.source,
      sourceDetail: {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      transformChain: [
        { stage: "window.location", value: `${location.pathname}${location.search}${location.hash}` || "/" },
        routeTarget.rawTarget ? { stage: routeTarget.targetType === "roomId" ? "router.params.roomId" : "router.params.joinToken", value: routeTarget.rawTarget } : null,
        typeof context.roomId === "string" ? { stage: "consumer-context.roomId", value: context.roomId } : null,
        typeof context.joinToken === "string" ? { stage: "consumer-context.joinToken", value: context.joinToken } : null,
      ].filter(Boolean),
      related: {
        roomName: typeof context.roomName === "string" ? context.roomName : null,
        joinToken: routeTarget.targetType === "joinToken" ? routeTarget.rawTarget : typeof context.joinToken === "string" ? context.joinToken : null,
        inviteLink: typeof context.inviteLink === "string" ? context.inviteLink : null,
        displayName: typeof context.displayName === "string" ? context.displayName : null,
        role: typeof context.role === "string" ? context.role : null,
        autoJoin: typeof context.autoJoin === "boolean" ? context.autoJoin : null,
      },
    },
    authContext: {
      authMode: typeof context.authMode === "string" ? context.authMode : activeToken?.source ?? "unknown",
      tokenSourcesSeen: [...new Set(tokenSummaries.map((summary) => summary.source))],
      activeToken,
      sessionHints: {
        hasCookies: parseCookieNames(browser.document.cookie).length > 0,
        localClientId: browser.storage.localStorage.chalk_internal_client_id_v1 ?? null,
        joinContextPresent: Boolean(browser.storage.sessionStorage.chalk_join_context_v1 ?? browser.storage.localStorage.chalk_join_context_v1),
      },
    },
    environment: {
      origin: location.origin,
      apiUrl: environment?.apiUrl ?? deriveApiUrl(logs),
      wsUrl: environment?.wsUrl ?? null,
      hostname: location.host,
      deployment: {
        label: location.host.includes("localhost") ? "local" : "remote",
      },
    },
    navigationContext: {
      currentUrl: location.url,
      referrer: location.referrer ?? null,
      historyLength: location.historyLength ?? null,
      visibilityState: location.visibilityState ?? null,
      entryPoint: routeTarget.entryPoint,
      restoredFromStorage: false,
    },
    browser: {
      navigator: browser.navigator,
      permissions: browser.permissions,
      devices: browser.devices,
      storage: {
        relevantKeys: {
          localStorage: Object.fromEntries(Object.entries(browser.storage.localStorage).filter(([key]) => /(chalk|room|join|auth|token)/i.test(key))),
          sessionStorage: Object.fromEntries(Object.entries(browser.storage.sessionStorage).filter(([key]) => /(chalk|room|join|auth|token)/i.test(key))),
        },
        full: browser.storage,
      },
      document: {
        ...browser.document,
        cookieNames: parseCookieNames(browser.document.cookie),
        cookie: browser.document.cookie ? "[REDACTED]" : null,
      },
    },
    sdkState: logs.sections.chalkSession ?? null,
    networkSummary: {
      requests: {
        total: logs.fetch.length,
        failed: logs.fetch.filter((record) => !record.ok).length,
      },
      firstRoomLookup: firstRoomLookup
        ? { attempted: true, status: firstRoomLookup.status ?? null }
        : { attempted: false, status: null },
      joinTokenRequest: (() => {
        const match = logs.fetch.find((record) => record.url.includes("/join-token"));
        return match ? { attempted: true, status: match.status ?? null } : { attempted: false, status: null };
      })(),
      participantJoinRequest: joinPost
        ? { attempted: true, status: joinPost.status ?? null }
        : { attempted: false, status: null },
    },
    timeline: compactTimeline(logs),
    logs: {
      snapshot: {
        ...logs,
        fetch: sanitizedFetch,
        sections: redact(logs.sections),
      },
    },
    raw: {
      context: redact(context),
      env: redact(environment?.env ?? null),
    },
  };
};
