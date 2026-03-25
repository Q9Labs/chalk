import { APIClient } from "@q9labs/chalk-core";
import { getPublicAppOrigin } from "./publicUrl";

type JoinContextV1 = {
  joinToken: string;
  roomId?: string;
  roomName?: string;
  accessToken?: string;
  expiresAtMs?: number;
};

export type InternalSession = {
  user: {
    email: string;
  };
};

type GoogleOAuthCodeResponse = {
  code?: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient(config: {
            client_id: string;
            scope: string;
            ux_mode?: "popup" | "redirect";
            redirect_uri?: string;
            callback: (response: GoogleOAuthCodeResponse) => void;
            error_callback?: () => void;
          }): {
            requestCode(): void;
          };
        };
      };
    };
  }
}

const JOIN_CONTEXT_KEY = "chalk_join_context_v1";
const INTERNAL_CLIENT_ID_KEY = "chalk_internal_client_id_v1";
const PROD_API_URL = "https://chalk-api.q9labs.ai";
const LOCAL_API_URL = "http://localhost:8080";
const GOOGLE_IDENTITY_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const CHALK_TOKEN_STORAGE_KEYS = [
  "chalk_access_token",
  "chalk_refresh_token",
  "chalk_token_expires",
] as const;
let googleIdentityScriptPromise: Promise<void> | null = null;

export function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export function resolveApiUrl(
  configuredApiUrl?: string,
  currentHostname?: string,
) {
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
  return resolveApiUrl(
    import.meta.env.VITE_API_URL,
    typeof window === "undefined" ? undefined : window.location.hostname,
  );
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

    const next =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `chalk-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const currentRoomID = decodeURIComponent(
    window.location.pathname.slice("/room/".length),
  );
  return currentRoomID === ctx.roomId;
}

export function getJoinContext(): JoinContextV1 | null {
  const ctx = readJoinContext();
  if (!ctx) return null;
  return isJoinContextActiveForCurrentRoom(ctx) ? ctx : null;
}

export function shouldUseInternalRoomAuth(
  pathname: string | undefined,
  search: string | undefined,
) {
  if (!(pathname ?? "").startsWith("/room/")) {
    return false;
  }

  const params = new URLSearchParams(search ?? "");
  return params.get("auth") === "internal";
}

export function shouldUseRoomScopedTokenProvider(pathname: string | undefined) {
  const normalizedPath = pathname ?? "";
  return (
    normalizedPath.startsWith("/room/") ||
    normalizedPath.startsWith("/j/") ||
    normalizedPath.startsWith("/dashboard")
  );
}

export function getChalkSessionCacheKey(
  pathname: string | undefined,
  search: string | undefined,
) {
  const normalizedPath = pathname ?? "";
  if (normalizedPath.startsWith("/room/")) {
    return `room:${normalizedPath}:${JSON.stringify(search ?? "")}`;
  }
  if (normalizedPath.startsWith("/j/")) {
    return `join:${normalizedPath}`;
  }
  if (normalizedPath.startsWith("/dashboard")) {
    return "dashboard";
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

export function clearStoredChalkTokens() {
  if (typeof window === "undefined") return;
  for (const key of CHALK_TOKEN_STORAGE_KEYS) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    } catch {
      // ignore storage failures; logout still proceeds
    }
  }
}

export function getAccessTokenExpiryMs(accessToken: string) {
  const jwtParts = accessToken.split(".");
  if (jwtParts.length < 2) {
    return null;
  }

  try {
    const payload = jwtParts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(jwtParts[1].length / 4) * 4, "=");
    const decoded =
      typeof atob === "function"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { exp?: number };
    if (typeof parsed.exp !== "number") {
      return null;
    }
    return parsed.exp * 1000;
  } catch {
    return null;
  }
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

export async function fetchInternalSession(
  apiUrl: string,
): Promise<InternalSession | null> {
  const res = await fetch(`${apiUrl}/api/v1/internal/auth/session`, {
    method: "GET",
    credentials: "include",
  });
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `session failed (${res.status})`);
  }
  return (await res.json()) as InternalSession;
}

export async function signInWithGoogleCode(apiUrl: string, code: string) {
  const res = await fetch(`${apiUrl}/api/v1/internal/auth/google`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `google auth failed (${res.status})`);
  }
  return (await res.json()) as { ok: true; user: InternalSession["user"] };
}

export async function logoutInternalSession(apiUrl: string) {
  const res = await fetch(`${apiUrl}/api/v1/internal/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `logout failed (${res.status})`);
  }
}

async function loadGoogleIdentityScript() {
  if (typeof window === "undefined") {
    throw new Error("Google sign-in is only available in the browser.");
  }
  if (window.google?.accounts.oauth2) {
    return;
  }
  if (!googleIdentityScriptPromise) {
    googleIdentityScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`,
      );
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Failed to load Google sign-in.")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load Google sign-in."));
      document.head.appendChild(script);
    }).finally(() => {
      if (!window.google?.accounts.oauth2) {
        googleIdentityScriptPromise = null;
      }
    });
  }

  await googleIdentityScriptPromise;
  if (!window.google?.accounts.oauth2) {
    throw new Error("Google sign-in did not initialize.");
  }
}

export async function startGoogleOAuthSignIn(apiUrl: string) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("Google OAuth is not configured.");
  }

  await loadGoogleIdentityScript();

  return await new Promise<void>((resolve, reject) => {
    const client = window.google?.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: "openid email profile",
      ux_mode: "popup",
      redirect_uri: window.location.origin,
      callback: async (response) => {
        if (!response.code) {
          reject(new Error("Google did not return an authorization code."));
          return;
        }

        try {
          await signInWithGoogleCode(apiUrl, response.code);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      error_callback: () =>
        reject(new Error("Google OAuth sign-in was cancelled or blocked.")),
    });

    if (!client) {
      reject(new Error("Google OAuth did not initialize."));
      return;
    }

    client.requestCode();
  });
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

export async function createRoomJoinLink(
  apiUrl: string,
  roomId: string,
  accessToken: string,
  origin?: string,
) {
  const res = await fetch(`${apiUrl}/api/v1/rooms/${roomId}/join-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`join link failed (${res.status})`);
  }

  const data = (await res.json()) as { join_token?: string };
  if (!data.join_token) {
    throw new Error("missing join token");
  }

  const baseOrigin =
    origin ?? getPublicAppOrigin();
  return new URL(`/j/${data.join_token}`, baseOrigin).toString();
}

export function createWebTokenProvider(apiUrl: string) {
  return async () => {
    const jc = getJoinContext();
    if (
      jc?.accessToken &&
      jc.expiresAtMs &&
      Date.now() < jc.expiresAtMs - 5_000
    ) {
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

    return await fetchInternalAccessToken(apiUrl);
  };
}
