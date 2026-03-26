/**
 * Token Provider Utility
 *
 * Handles the complete auth flow: API key → JWT with automatic refresh.
 * Supports browser (sessionStorage/localStorage) and custom storage (React Native).
 */

import { wideEvents } from "./wide-events/index.ts";

const STORAGE_KEY_ACCESS = "chalk_access_token";
const STORAGE_KEY_REFRESH = "chalk_refresh_token";
const STORAGE_KEY_EXPIRES = "chalk_token_expires";

/** Custom storage interface for React Native, SSR, etc. */
export interface TokenStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface CreateTokenProviderConfig {
  apiKey: string;
  apiUrl: string;
  /** Default: 'sessionStorage'. Use 'localStorage' for persistence or custom TokenStorage for React Native. */
  storage?: "sessionStorage" | "localStorage" | TokenStorage;
}

export interface CreateJoinTokenProviderConfig {
  apiUrl: string;
  joinToken: string;
  /** Refresh this many milliseconds before expiry. */
  skewMs?: number;
}

export interface CreateSessionTokenProviderConfig {
  apiUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Refresh this many milliseconds before expiry. */
  skewMs?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const createRequestMeta = (response: Response) => ({
  statusCode: response.status,
  requestId: response.headers?.get?.("x-request-id") ?? null,
  traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
  cfRay: response.headers?.get?.("cf-ray") ?? null,
});

const performTokenRequest = async <T>(method: string, apiUrl: string, path: string, body: unknown, errorPrefix: string): Promise<T> => {
  const ctx = wideEvents.start("api.request");
  ctx.set("request", { method, path, hasBody: body !== undefined });

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const responseMeta = createRequestMeta(response);

    if (!response.ok) {
      const err = await response.text().catch(() => "Unknown error");
      ctx.set("response", responseMeta);
      ctx.complete("error", {
        code: `HTTP_${response.status}`,
        message: `${errorPrefix}: ${err}`,
      });
      throw new Error(`${errorPrefix}: ${err}`);
    }

    ctx.set("response", responseMeta);
    ctx.complete("success");
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof Error) {
      ctx.complete("error", error);
      throw error;
    }

    const normalized = new Error(String(error));
    ctx.complete("error", normalized);
    throw normalized;
  }
};

/**
 * Normalizes storage to async interface
 */
function normalizeStorage(storage: "sessionStorage" | "localStorage" | TokenStorage | undefined): TokenStorage {
  if (!storage || storage === "sessionStorage") {
    if (typeof sessionStorage === "undefined") {
      // SSR or non-browser - use in-memory fallback
      const mem = new Map<string, string>();
      return {
        get: (key) => mem.get(key) ?? null,
        set: (key, value) => {
          mem.set(key, value);
        },
        remove: (key) => {
          mem.delete(key);
        },
      };
    }
    return {
      get: (key) => sessionStorage.getItem(key),
      set: (key, value) => sessionStorage.setItem(key, value),
      remove: (key) => sessionStorage.removeItem(key),
    };
  }

  if (storage === "localStorage") {
    if (typeof localStorage === "undefined") {
      const mem = new Map<string, string>();
      return {
        get: (key) => mem.get(key) ?? null,
        set: (key, value) => {
          mem.set(key, value);
        },
        remove: (key) => {
          mem.delete(key);
        },
      };
    }
    return {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
      remove: (key) => localStorage.removeItem(key),
    };
  }

  return storage;
}

/**
 * Creates a token provider that handles API key → JWT exchange and automatic refresh.
 *
 * @example Browser (default)
 * ```ts
 * const tokenProvider = createTokenProvider({
 *   apiKey: 'ck_live_xxx',
 *   apiUrl: 'https://api.example.com',
 * });
 * ```
 *
 * @example React Native with AsyncStorage
 * ```ts
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 *
 * const tokenProvider = createTokenProvider({
 *   apiKey: 'ck_live_xxx',
 *   apiUrl: 'https://api.example.com',
 *   storage: {
 *     get: (key) => AsyncStorage.getItem(key),
 *     set: (key, value) => AsyncStorage.setItem(key, value),
 *     remove: (key) => AsyncStorage.removeItem(key),
 *   },
 * });
 * ```
 */
export function createTokenProvider(config: CreateTokenProviderConfig): () => Promise<string> {
  const { apiKey, apiUrl } = config;
  const storage = normalizeStorage(config.storage);

  // Serialize concurrent refresh requests
  let refreshPromise: Promise<string> | null = null;

  async function fetchInitialToken(): Promise<TokenResponse> {
    return performTokenRequest<TokenResponse>("POST", apiUrl, "/api/v1/auth/token", { api_key: apiKey }, "Token exchange failed");
  }

  async function refreshToken(refreshTok: string): Promise<TokenResponse> {
    try {
      return await performTokenRequest<TokenResponse>("POST", apiUrl, "/api/v1/auth/refresh", { refresh_token: refreshTok }, "Token refresh failed");
    } catch (error) {
      // Clear tokens on refresh failure
      await Promise.all([storage.remove(STORAGE_KEY_ACCESS), storage.remove(STORAGE_KEY_REFRESH), storage.remove(STORAGE_KEY_EXPIRES)]);
      throw error;
    }
  }

  async function storeTokens(tokens: TokenResponse): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await Promise.all([storage.set(STORAGE_KEY_ACCESS, tokens.access_token), storage.set(STORAGE_KEY_REFRESH, tokens.refresh_token), storage.set(STORAGE_KEY_EXPIRES, String(expiresAt))]);
  }

  async function isExpired(): Promise<boolean> {
    const expiresStr = await storage.get(STORAGE_KEY_EXPIRES);
    if (!expiresStr) return true;
    // Refresh 30 seconds before expiry
    return Date.now() > Number(expiresStr) - 30_000;
  }

  return async (): Promise<string> => {
    // Check for existing valid token
    const accessToken = await storage.get(STORAGE_KEY_ACCESS);
    const expired = await isExpired();

    if (accessToken && !expired) {
      return accessToken;
    }

    // Serialize concurrent requests
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const refreshTok = await storage.get(STORAGE_KEY_REFRESH);

        // Try refresh if we have a refresh token
        if (refreshTok) {
          try {
            const tokens = await refreshToken(refreshTok);
            await storeTokens(tokens);
            return tokens.access_token;
          } catch {
            // Refresh failed - fall through to initial token
          }
        }

        // No refresh token or refresh failed - get initial token via API key
        const tokens = await fetchInitialToken();
        await storeTokens(tokens);
        return tokens.access_token;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };
}

export function createJoinTokenProvider(config: CreateJoinTokenProviderConfig): () => Promise<string> {
  const { apiUrl, joinToken, skewMs = 5_000 } = config;

  let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;
  let exchangePromise: Promise<string> | null = null;

  async function exchangeJoinToken(): Promise<{ access_token: string; expires_in: number }> {
    return performTokenRequest<{ access_token: string; expires_in: number }>("POST", apiUrl, "/api/v1/public/join-token/exchange", { join_token: joinToken }, "Join token exchange failed");
  }

  return async (): Promise<string> => {
    if (cachedToken && Date.now() < cachedToken.expiresAtMs - skewMs) {
      return cachedToken.accessToken;
    }

    if (exchangePromise) {
      return exchangePromise;
    }

    exchangePromise = (async () => {
      try {
        const tokens = await exchangeJoinToken();
        cachedToken = {
          accessToken: tokens.access_token,
          expiresAtMs: Date.now() + tokens.expires_in * 1000,
        };
        return cachedToken.accessToken;
      } finally {
        exchangePromise = null;
      }
    })();

    return exchangePromise;
  };
}

export function createSessionTokenProvider(config: CreateSessionTokenProviderConfig): () => Promise<string> {
  const { apiUrl, skewMs = 30_000 } = config;
  let accessToken = config.accessToken;
  let refreshToken = config.refreshToken;
  let expiresAt = config.expiresAt;
  let refreshPromise: Promise<string> | null = null;

  const isExpired = () => typeof expiresAt === "number" && Date.now() >= expiresAt - skewMs;

  async function refreshSessionToken(currentRefreshToken: string): Promise<TokenResponse> {
    return performTokenRequest<TokenResponse>("POST", apiUrl, "/api/v1/auth/refresh", { refresh_token: currentRefreshToken }, "Session token refresh failed");
  }

  return async (): Promise<string> => {
    if (accessToken && !isExpired()) {
      return accessToken;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    if (!refreshToken) {
      throw new Error("Session access token expired and no refresh token is available");
    }

    refreshPromise = (async () => {
      try {
        const refreshed = await refreshSessionToken(refreshToken!);
        accessToken = refreshed.access_token;
        refreshToken = refreshed.refresh_token || refreshToken;
        expiresAt = Date.now() + refreshed.expires_in * 1000;
        return accessToken;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };
}
