/**
 * Token Provider Utility
 *
 * Handles the complete auth flow: API key → JWT with automatic refresh.
 * Supports browser (sessionStorage/localStorage) and custom storage (React Native).
 */

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

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

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
    const response = await fetch(`${apiUrl}/api/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "Unknown error");
      throw new Error(`Token exchange failed: ${err}`);
    }

    return response.json();
  }

  async function refreshToken(refreshTok: string): Promise<TokenResponse> {
    const response = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshTok }),
    });

    if (!response.ok) {
      // Clear tokens on refresh failure
      await Promise.all([storage.remove(STORAGE_KEY_ACCESS), storage.remove(STORAGE_KEY_REFRESH), storage.remove(STORAGE_KEY_EXPIRES)]);
      throw new Error("Token refresh failed");
    }

    return response.json();
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
    const response = await fetch(`${apiUrl}/api/v1/public/join-token/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ join_token: joinToken }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "Unknown error");
      throw new Error(`Join token exchange failed: ${err}`);
    }

    return response.json();
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
