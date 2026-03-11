import { APIClient, type RoomResource } from "@q9labs/chalk-core";

type JoinContextV1 = {
  joinToken: string;
  roomName?: string;
  accessToken?: string;
  expiresAtMs?: number;
};

const JOIN_CONTEXT_KEY = "chalk_join_context_v1";
const LOCAL_CLIENT_ID_KEY = "chalk_local_client_id_v1";
const verifiedMagicLinks = new Set<string>();
const inFlightMagicLinkVerifications = new Map<string, Promise<void>>();
const PROD_API_URL = "https://chalk-api.q9labs.ai";
const LOCAL_API_URL = "http://localhost:8080";

export function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized.endsWith(".localhost");
}

export function resolveApiUrl(configuredApiUrl?: string, currentHostname?: string) {
  const normalizedConfigured = configuredApiUrl?.trim();
  if (isLocalHost(currentHostname)) {
    if (!normalizedConfigured) {
      return LOCAL_API_URL;
    }

    try {
      const configuredHost = new URL(normalizedConfigured).hostname;
      if (!isLocalHost(configuredHost)) {
        return LOCAL_API_URL;
      }
    } catch {
      return LOCAL_API_URL;
    }
  }
  return normalizedConfigured || PROD_API_URL;
}

export function getApiUrl() {
  return resolveApiUrl(import.meta.env.VITE_API_URL, typeof window === "undefined" ? undefined : window.location.hostname);
}

export function getOrCreateLocalClientId() {
  if (typeof window === "undefined" || !isLocalHost(window.location.hostname)) {
    return null;
  }

  try {
    const existing = localStorage.getItem(LOCAL_CLIENT_ID_KEY);
    if (existing) {
      return existing;
    }

    const next = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `chalk-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(LOCAL_CLIENT_ID_KEY, next);
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
  if (!ctx.roomName) return false;
  if (!window.location.pathname.startsWith("/room/")) return false;
  const currentRoomName = decodeURIComponent(window.location.pathname.slice("/room/".length));
  return currentRoomName === ctx.roomName;
}

export function getJoinContext(): JoinContextV1 | null {
  const ctx = readJoinContext();
  if (!ctx) return null;
  return isJoinContextActiveForCurrentRoom(ctx) ? ctx : null;
}

export function shouldUseInternalRoomAuth(pathname: string | undefined, search: string | undefined) {
  if (!(pathname ?? "").startsWith("/room/")) {
    return false;
  }

  const params = new URLSearchParams(search ?? "");
  return params.get("auth") === "internal";
}

export function shouldPrimeTokenCache(pathname: string | undefined) {
  return !(pathname ?? "").startsWith("/j/");
}

export function setJoinContext(ctx: JoinContextV1) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(JOIN_CONTEXT_KEY, JSON.stringify(ctx));
}

export function clearJoinContext() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(JOIN_CONTEXT_KEY);
}

export async function fetchInternalAccessToken(apiUrl: string) {
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
    throw new Error(`auth failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string };
  if (!data.access_token) throw new Error("missing access token");
  return data.access_token;
}

export async function startMagicLink(apiUrl: string, email: string) {
  const callbackUrl = typeof window === "undefined" ? undefined : `${window.location.origin}/dashboard`;

  const res = await fetch(`${apiUrl}/api/v1/internal/auth/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, callback_url: callbackUrl }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `failed to send email (${res.status})`);
  }
}

export async function verifyMagicLink(apiUrl: string, token: string) {
  const verificationKey = `${apiUrl}::${token}`;
  if (verifiedMagicLinks.has(verificationKey)) {
    return;
  }

  const existingRequest = inFlightMagicLinkVerifications.get(verificationKey);
  if (existingRequest) {
    await existingRequest;
    return;
  }

  const request = (async () => {
    const res = await fetch(`${apiUrl}/api/v1/internal/auth/verify`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(data?.error || `invalid link (${res.status})`);
    }
    verifiedMagicLinks.add(verificationKey);
  })().finally(() => {
    inFlightMagicLinkVerifications.delete(verificationKey);
  });

  inFlightMagicLinkVerifications.set(verificationKey, request);
  await request;
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
    room_name: response.data.roomName,
  };
}

export async function getRoomWithAccessToken(apiUrl: string, accessToken: string, roomId: string): Promise<RoomResource> {
  const client = new APIClient({ apiUrl, token: accessToken });
  const response = await client.getRoom(roomId);
  if (!response.success || !response.data) {
    throw new Error(response.error?.message ?? "failed to load room");
  }
  return response.data;
}

export function createWebTokenProvider(apiUrl: string) {
  return async () => {
    const jc = getJoinContext();
    if (jc?.joinToken) {
      if (jc.accessToken && jc.expiresAtMs && Date.now() < jc.expiresAtMs - 5_000) {
        return jc.accessToken;
      }

      const ex = await exchangeJoinToken(apiUrl, jc.joinToken);
      const expiresAtMs = Date.now() + ex.expires_in * 1000;
      setJoinContext({
        joinToken: jc.joinToken,
        roomName: ex.room_name,
        accessToken: ex.access_token,
        expiresAtMs,
      });
      return ex.access_token;
    }

    return await fetchInternalAccessToken(apiUrl);
  };
}
