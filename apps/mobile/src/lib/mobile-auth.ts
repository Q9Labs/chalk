export interface TokenStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface CreateTokenProviderConfig {
  apiKey: string;
  apiUrl: string;
  storage: TokenStorage;
}

const STORAGE_KEY_ACCESS = "chalk_access_token";
const STORAGE_KEY_REFRESH = "chalk_refresh_token";
const STORAGE_KEY_EXPIRES = "chalk_token_expires";

async function requestToken(apiUrl: string, path: string, body: unknown, errorPrefix: string): Promise<TokenResponse> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "Unknown error");
    throw new Error(`${errorPrefix}: ${message}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export function createTokenProvider({ apiKey, apiUrl, storage }: CreateTokenProviderConfig): () => Promise<string> {
  let refreshPromise: Promise<string> | null = null;

  const storeTokens = async (tokens: TokenResponse): Promise<void> => {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await Promise.all([storage.set(STORAGE_KEY_ACCESS, tokens.access_token), storage.set(STORAGE_KEY_REFRESH, tokens.refresh_token), storage.set(STORAGE_KEY_EXPIRES, String(expiresAt))]);
  };

  const isExpired = async (): Promise<boolean> => {
    const expiresAt = await storage.get(STORAGE_KEY_EXPIRES);
    return !expiresAt || Date.now() > Number(expiresAt) - 30_000;
  };

  return async () => {
    const accessToken = await storage.get(STORAGE_KEY_ACCESS);
    if (accessToken && !(await isExpired())) {
      return accessToken;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const refreshToken = await storage.get(STORAGE_KEY_REFRESH);
        if (refreshToken) {
          try {
            const tokens = await requestToken(apiUrl, "/api/v1/auth/refresh", { refresh_token: refreshToken }, "Token refresh failed");
            await storeTokens(tokens);
            return tokens.access_token;
          } catch {
            await Promise.all([storage.remove(STORAGE_KEY_ACCESS), storage.remove(STORAGE_KEY_REFRESH), storage.remove(STORAGE_KEY_EXPIRES)]);
          }
        }

        const tokens = await requestToken(apiUrl, "/api/v1/auth/token", { api_key: apiKey }, "Token exchange failed");
        await storeTokens(tokens);
        return tokens.access_token;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };
}
