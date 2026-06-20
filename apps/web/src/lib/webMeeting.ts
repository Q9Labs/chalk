import { APIClient } from "@q9labs/chalk-core";

type JoinContextV1 = {
  joinToken?: string;
  roomId?: string;
  roomName?: string;
  accessToken?: string;
  expiresAtMs?: number;
};

const JOIN_CONTEXT_KEY = "chalk_join_context_v1";
const INTERNAL_CLIENT_ID_KEY = "chalk_internal_client_id_v1";
const PROD_API_URL = "https://chalk-api.q9labs.ai";
const LOCAL_API_URL = "http://localhost:8080";

export function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized.endsWith(".localhost");
}

export function resolveApiUrl(configuredApiUrl?: string, currentHostname?: string) {
  const normalizedConfigured = configuredApiUrl?.trim();
  const currentIsLocal = isLocalHost(currentHostname);
  if (!normalizedConfigured) {
    return currentIsLocal ? LOCAL_API_URL : PROD_API_URL;
  }

  try {
    const configuredHost = new URL(normalizedConfigured).hostname;
    const configuredIsLocal = isLocalHost(configuredHost);
    if (currentIsLocal) {
      return configuredIsLocal ? normalizedConfigured : LOCAL_API_URL;
    }
    if (configuredIsLocal) {
      return PROD_API_URL;
    }
  } catch {
    return currentIsLocal ? LOCAL_API_URL : PROD_API_URL;
  }
  return normalizedConfigured || PROD_API_URL;
}

export function getApiUrl() {
  return resolveApiUrl(import.meta.env.VITE_API_URL, typeof window === "undefined" ? undefined : window.location.hostname);
}

export function getOrCreateLocalClientId() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const existing = localStorage.getItem(INTERNAL_CLIENT_ID_KEY);
    if (existing) {
      return existing;
    }

    const next = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `chalk-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(INTERNAL_CLIENT_ID_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function readJoinContext(): JoinContextV1 | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(JOIN_CONTEXT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as JoinContextV1;
  } catch {
    return null;
  }
}

function isJoinContextActiveForCurrentRoom(ctx: JoinContextV1) {
  if (typeof window === "undefined") return true;
  if (!ctx.roomId) return false;
  if (!window.location.pathname.startsWith("/room/")) return false;
  const currentRoomID = decodeURIComponent(window.location.pathname.slice("/room/".length));
  return currentRoomID === ctx.roomId;
}

export function getJoinContext(): JoinContextV1 | null {
  const ctx = readJoinContext();
  if (!ctx) return null;
  return isJoinContextActiveForCurrentRoom(ctx) ? ctx : null;
}

export function shouldUseRoomScopedTokenProvider(pathname: string | undefined) {
  const normalizedPath = pathname ?? "";
  return normalizedPath.startsWith("/room/") || normalizedPath.startsWith("/j/");
}

export function getChalkSessionCacheKey(pathname: string | undefined, search: string | undefined) {
  const normalizedPath = pathname ?? "";
  if (normalizedPath.startsWith("/room/")) {
    return `room:${normalizedPath}:${JSON.stringify(search ?? "")}`;
  }
  if (normalizedPath.startsWith("/j/")) {
    return `join:${normalizedPath}`;
  }
  return "app";
}

export function shouldPrimeTokenCache(pathname: string | undefined) {
  return (pathname ?? "").startsWith("/room/");
}

export function setJoinContext(ctx: JoinContextV1) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(JOIN_CONTEXT_KEY, JSON.stringify(ctx));
}

export function clearJoinContext() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(JOIN_CONTEXT_KEY);
}

export function getAccessTokenExpiryMs(accessToken: string) {
  const jwtParts = accessToken.split(".");
  const payloadPart = jwtParts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payload = payloadPart
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    const decoded = typeof atob === "function" ? atob(payload) : Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { exp?: number };
    if (typeof parsed.exp !== "number") {
      return null;
    }
    return parsed.exp * 1000;
  } catch {
    return null;
  }
}

export async function fetchWebAccessToken(apiUrl: string) {
  const localClientId = getOrCreateLocalClientId();
  const res = await fetch(`${apiUrl}/api/v1/internal/auth/access-token`, {
    method: "GET",
    credentials: "include",
    headers: localClientId
      ? {
          "X-Chalk-Local-Client-ID": localClientId,
        }
      : undefined,
  });
  if (!res.ok) {
    throw new Error(`token request failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) throw new Error("missing access token");
  return data.access_token;
}

export async function exchangeJoinToken(apiUrl: string, joinToken: string) {
  const client = new APIClient({ apiUrl });
  const response = await client.exchangeJoinToken(joinToken);
  if (!response.success || !response.data) {
    throw new Error(response.error?.message ?? "invalid join link");
  }

  return {
    access_token: response.data.accessToken,
    expires_in: response.data.expiresIn,
    room_id: response.data.roomId,
    room_name: response.data.roomName,
  };
}

export function createWebTokenProvider(apiUrl: string) {
  return async () => {
    const jc = getJoinContext();
    if (jc?.accessToken && jc.expiresAtMs && Date.now() < jc.expiresAtMs - 5_000) {
      return jc.accessToken;
    }

    if (jc?.joinToken) {
      const ex = await exchangeJoinToken(apiUrl, jc.joinToken);
      const expiresAtMs = Date.now() + ex.expires_in * 1000;
      setJoinContext({
        joinToken: jc.joinToken,
        roomId: ex.room_id,
        roomName: ex.room_name,
        accessToken: ex.access_token,
        expiresAtMs,
      });
      return ex.access_token;
    }

    return await fetchWebAccessToken(apiUrl);
  };
}
